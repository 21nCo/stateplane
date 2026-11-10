// Shared by the cell's projection workers: one transaction helper and one
// fault taxonomy, so the record outbox and retrieval work classify a provider
// outage, a lost session or an item's own failure the same way.
import type pg from 'pg';
import { EMBEDDER_UNAVAILABLE, PROJECTION_INCOMPLETE } from '@stateplane/retrieval';
import { AuthorityError, clientReadTimedOut, CommitOutcomeUnknownError } from './index.js';
import { scalarString } from './schema.js';

export type PoolLike = Pick<pg.Pool, 'connect'>;
// Initial protective bound, not measured provider capacity: one statement stays short.
export const STATEMENT_MS = 5_000;
// How far a bounded transaction's statement bound may exceed the time it has
// left before it is lowered: a cancellation ends a statement at the deadline,
// so this only spares a round trip per statement.
export const STATEMENT_SLACK_MS = 100;
// How long the cancellation of a statement a deadline cut short may take, checkout included.
export const CANCEL_MS = 1_000;

export class ProjectorFailure extends Error {}

// A lost session, a rolled-back serialization or deadlock, exhausted
// resources, a lock budget, a server shutdown or a system I/O error, plus the
// driver's socket, connection and client read errors. A statement timeout is
// not here: an overrun is the item's. The client read bound sits past every
// server bound (CLIENT_READ_TIMEOUT_MS), so it fires only on a lost session.
export const INFRASTRUCTURE_SQLSTATE = /^(?:(?:08|40|53|58)[\dA-Z]{3}|55P03|57P0\d)$/;
// Network errnos that clear when a peer, route or resolver recovers. Any other
// errno is the item's, including ENOTFOUND (a misconfigured host is not an
// outage), EINVAL, ENOENT and EACCES, so a deterministic failure still parks.
export const TRANSIENT_ERRNOS: ReadonlySet<string> = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EAI_AGAIN',
  // An embedder outage, and preparation that saved its progress and stopped
  // at its budget, as the retrieval port reports them.
  EMBEDDER_UNAVAILABLE, PROJECTION_INCOMPLETE]);
// Node's fetch reports a socket failure as TypeError('fetch failed') with the
// errno as its cause, and a multi-address connect as an AggregateError, so a
// fault is read through its cause and AggregateError links. Those chains are
// two or three errors deep; the walk stops after eight, so a cyclic or
// pathological chain still settles promptly, and as the item's.
export const CAUSE_WALK = 8;

/** The errors a bounded, cycle-safe breadth-first walk of cause and AggregateError links reaches. */
export function causes(error: unknown): Error[] {
  const found: Error[] = [];
  const queue = [error];
  for (let next = 0; next < queue.length && found.length < CAUSE_WALK; next++) {
    const current = queue[next];
    if (!(current instanceof Error) || found.includes(current)) continue;
    found.push(current);
    if (current instanceof AggregateError && Array.isArray(current.errors)) queue.push(...current.errors.slice(0, CAUSE_WALK));
    queue.push(current.cause);
  }
  return found;
}

export function errorCode(error: Error): unknown { return (error as { code?: unknown }).code; }

export function transient(error: Error): boolean {
  if (error instanceof AuthorityError) return false;
  const code = errorCode(error);
  if (typeof code === 'string') return INFRASTRUCTURE_SQLSTATE.test(code) || TRANSIENT_ERRNOS.has(code);
  return clientReadTimedOut(error) || /^Connection terminated|not queryable|^timeout exceeded when trying to connect/.test(error.message);
}

/**
 * The one positive taxonomy for every started-lease fault: true releases
 * uncounted, anything else counts. A fault is infrastructure when its walk
 * reaches a transient error and no AuthorityError, such as the budget overrun.
 */
export function infrastructureFault(error: unknown): error is Error {
  const walked = causes(error);
  return walked.some(transient) && !walked.some(entry => entry instanceof AuthorityError);
}

// A projector's own error is the item's, except a positively classified
// infrastructure fault such as a provider's ECONNRESET during an outage, which
// stays unwrapped so the lease is released uncounted. The budget overrun is
// an AuthorityError, so it still counts.
export function projectorError(stage: 'prepare' | 'apply', error: unknown): unknown {
  return infrastructureFault(error) ? error : new ProjectorFailure(`${stage} failed`, { cause: error });
}

// An error reply from a live session means the server rolled COMMIT back.
// Session loss, shutdown, resource and internal errors may arrive at FATAL or
// PANIC after the commit record, so they stay ambiguous. A Node system error
// (a socket's EPIPE or EPERM, which also has five capitals) is no reply at
// all: it carries `errno` or `syscall`, and no PostgreSQL class starts with E.
export function rolledBack(error: unknown): boolean {
  const fields = error as { code?: unknown; errno?: unknown; syscall?: unknown } | null | undefined;
  const code = fields?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !/^(?:08|53|57P|58|XX|E)/.test(code)
    && fields?.errno === undefined && fields?.syscall === undefined;
}

/** The caller's budget ended before COMMIT was sent; the transaction rolled back. */
export class DeadlineExceededError extends Error {}

/** What a transaction body gets: one query at a time, as `pg.PoolClient#query` takes them. */
export interface Session { query(sql: string, values?: unknown[]): Promise<pg.QueryResult> }

/** A transaction's budget: it ends at `deadline` (epoch ms) or when `signal` aborts, whichever is first. */
export interface Limit { deadline: number; signal?: AbortSignal }

/**
 * Run one short cell transaction; a missing COMMIT acknowledgement stays
 * ambiguous. With `limit`, every statement of the transaction, from BEGIN
 * to COMMIT or ROLLBACK, is sent only before the budget ends and awaited
 * only until it does, and the body's statements are each bounded by the
 * time left when they start (`statement_timeout`, lowered again whenever
 * the time left falls more than `STATEMENT_SLACK_MS` below it; after a
 * statement error, only once a rollback has gone through, as the aborted
 * transaction refuses anything else). Checking the
 * session out is bounded too. When the budget ends, the statement in flight
 * is abandoned and cancelled from another session and this session is
 * discarded, so the transaction's locks go then, or at the latest when that
 * statement's own bound ends it. A transaction cut short before COMMIT rolls
 * back as a `DeadlineExceededError`; one cut short while COMMIT is in
 * flight is a `CommitOutcomeUnknownError`.
 */
export async function inTransaction<T>(pool: PoolLike, fn: (db: pg.PoolClient) => Promise<T>): Promise<T>;
export async function inTransaction<T>(pool: PoolLike, fn: (db: Session) => Promise<T>, limit: Limit): Promise<T>;
export async function inTransaction<T>(pool: PoolLike, fn: (db: never) => Promise<T>, limit?: Limit): Promise<T> {
  const ended = () => limit !== undefined && (Date.now() >= limit.deadline || limit.signal?.aborted === true);
  if (ended()) throw new DeadlineExceededError('The time budget ended before the transaction');
  const client = limit ? await checkout(pool, limit) : await pool.connect();
  if (ended()) { client.release(); throw new DeadlineExceededError('The time budget ended before the transaction'); }
  let begun = false;
  // An unacknowledged BEGIN or COMMIT leaves the session state unknown.
  let discard = true;
  // The budget ended: a statement in flight then was abandoned, and the session is discarded unread.
  let cut = false;
  // The pool detaches its listener on checkout; a server-ended session must
  // fail this transaction, not the process.
  const onError = () => { discard = true; };
  client.on?.('error', onError);
  let statementMs = Math.max(1, Math.min(STATEMENT_MS, limit ? limit.deadline - Date.now() : STATEMENT_MS));
  // Settles at the deadline or the signal's abort, whichever is first.
  let expire: () => void = () => {};
  const expired = new Promise<never>((_, reject) => {
    expire = () => reject(new DeadlineExceededError('The time budget ended during the transaction'));
  });
  expired.catch(() => {});
  const timer = limit ? setTimeout(expire, Math.max(0, limit.deadline - Date.now())) : undefined;
  limit?.signal?.addEventListener('abort', expire, { once: true });
  // A statement failed: the transaction takes nothing but a rollback until one succeeds, so no bound is set before it.
  let aborted = false;
  // A rollback to a savepoint also undoes the bounds set since it: the next statement sets its bound again.
  let unbound = false;
  const guarded = async (sql: string, values?: unknown[]) => {
    const remaining = limit!.deadline - Date.now();
    if (!aborted && (unbound || remaining < statementMs - STATEMENT_SLACK_MS)) {
      statementMs = Math.max(1, Math.min(statementMs, remaining));
      await run(`SET LOCAL statement_timeout = '${statementMs}ms'`);
      unbound = false;
    }
    try {
      const result = await run(sql, values);
      if (aborted) { aborted = false; unbound = true; }
      return result;
    } catch (error) {
      if (!(error instanceof DeadlineExceededError)) aborted = true;
      throw error;
    }
  };
  // This session's backend and transaction, read at BEGIN when the transaction is bounded.
  let backend: { pid: number; began: string } | undefined;
  // Every statement; bounded, none is sent once the budget ends, and one in flight then is abandoned.
  const run = async (sql: string, values?: unknown[]) => {
    if (!limit) return client.query(sql, values);
    if (cut || ended()) { cut = true; discard = true; throw new DeadlineExceededError('The time budget ended during the transaction'); }
    const pending = client.query(sql, values);
    pending.catch(() => {});
    try { return await Promise.race([pending, expired]); }
    catch (error) {
      if (error instanceof DeadlineExceededError && !cut) {
        cut = true; discard = true;
        if (backend) cancelBackend(pool, backend);
      }
      throw error;
    }
  };
  // Unbounded, the body gets the client itself.
  const session = (limit ? { query: guarded } : client) as never;
  try {
    await run('BEGIN'); begun = true; discard = false;
    if (limit) {
      // SET LOCAL, and what a cancellation needs, in one round trip.
      const row = (await run(`SELECT set_config('statement_timeout',$1,true),pg_backend_pid() AS pid,
        now()::text AS began`, [`${statementMs}ms`])).rows[0];
      backend = { pid: Number(row.pid), began: row.began };
    } else await run(`SET LOCAL statement_timeout = '${statementMs}ms'`);
    const result = await fn(session);
    if (cut || ended()) throw new DeadlineExceededError('The time budget ended before COMMIT');
    try { await run('COMMIT'); begun = false; }
    catch (error) { discard = true; begun = false; throw new CommitOutcomeUnknownError(error); }
    return result;
  } catch (error) {
    if (clientReadTimedOut(error) || cut) discard = true;
    // Bounded, a ROLLBACK is not sent after the budget ends, and one in flight then discards the session.
    else if (begun) await run('ROLLBACK').catch(() => { discard = true; });
    // A statement cut short by the deadline, not by its own bound, is the budget's end.
    if (!(error instanceof DeadlineExceededError) && limit && statementMs < STATEMENT_MS
      && (error as { code?: unknown })?.code === '57014')
      throw new DeadlineExceededError('The time budget ended during the transaction', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    limit?.signal?.removeEventListener('abort', expire);
    client.release(discard); client.removeListener?.('error', onError);
  }
}

/**
 * Check a session out within the budget. One that arrives after the deadline
 * or the abort goes straight back to the pool, unused.
 */
async function checkout(pool: PoolLike, limit: Limit): Promise<pg.PoolClient> {
  let late = false;
  const connecting = pool.connect();
  connecting.then(client => { if (late) client.release(); }, () => {});
  let expire: () => void = () => {};
  const expired = new Promise<never>((_, reject) => {
    expire = () => { late = true; reject(new DeadlineExceededError('The time budget ended before the transaction')); };
  });
  const timer = setTimeout(expire, Math.max(0, limit.deadline - Date.now()));
  limit.signal?.addEventListener('abort', expire, { once: true });
  try { return await Promise.race([connecting, expired]); }
  finally { clearTimeout(timer); limit.signal?.removeEventListener('abort', expire); }
}

/**
 * Cancel an abandoned transaction's statement from another session, best
 * effort and unawaited. Only while that backend is still in the same
 * transaction: a reused pid, or a pooled backend now serving another
 * transaction, is left alone. The whole attempt, checkout included, ends
 * within `CANCEL_MS` of the cut: a session that arrives later goes back
 * unused, and one whose cancel has not answered by then, or failed, is
 * discarded, so on a one-session pool a stalled cancellation holds the
 * session for at most that long.
 */
function cancelBackend(pool: PoolLike, backend: { pid: number; began: string }): void {
  const limit = { deadline: Date.now() + CANCEL_MS };
  void (async () => {
    const other = await checkout(pool, limit);
    let broken = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancel = other.query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND xact_start=$2::timestamptz`,
        [backend.pid, backend.began]);
      cancel.catch(() => {});
      await Promise.race([cancel, new Promise((_, reject) => { timer = setTimeout(reject, Math.max(0, limit.deadline - Date.now())); })]);
      broken = false;
    } catch { /* discarded below */ } finally { clearTimeout(timer); other.release(broken); }
  })().catch(() => {});
}

export function bounded(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new AuthorityError('INVALID_ARGUMENT');
  return value as number;
}

export function text(value: unknown, maxBytes: number): string {
  if (!scalarString(value) || !value || Buffer.byteLength(value) > maxBytes) throw new AuthorityError('INVALID_ARGUMENT');
  return value;
}

/**
 * Keep a NUL-free diagnostic of at most 1,024 UTF-8 bytes. Projectors must not put record content
 * in errors. Postgres, Node and socket errors can quote rejected values,
 * hosts or credentials, so any error with a string code keeps only its name
 * and code. The same walk as the classification picks the error shown: an
 * AuthorityError, else the transient fault, else the first coded error.
 */
export function diagnostic(error: unknown): string {
  const top = error instanceof ProjectorFailure ? error.cause : error;
  if (!(top instanceof Error)) return 'Projection failed';
  const walked = causes(top);
  const shown = walked.find(entry => entry instanceof AuthorityError) ?? walked.find(transient)
    ?? walked.find(entry => typeof errorCode(entry) === 'string') ?? top;
  const code = errorCode(shown);
  const coded = !(shown instanceof AuthorityError) && typeof code === 'string';
  const message = coded ? `${shown.name} ${code}` : `${shown.name}: ${shown.message}`;
  return utf8Prefix(message.replaceAll('\0', ''), 1024) || 'Projection failed';
}

/** The longest prefix of whole code points within `maxBytes` of UTF-8; an unpaired surrogate counts as the 3-byte U+FFFD it is sent as. */
export function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const point of value) {
    bytes += Buffer.byteLength(point);
    if (bytes > maxBytes) break;
    end += point.length;
  }
  return value.slice(0, end);
}

/** Settle when the work does or the budget expires, whichever is first. */
export function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AuthorityError('RATE_LIMITED', 'Projection time budget exceeded'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

