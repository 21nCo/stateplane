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
// PANIC after the commit record, so they stay ambiguous.
export function rolledBack(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !/^(?:08|53|57P|58|XX)/.test(code);
}

/** Run one short cell transaction; a missing COMMIT acknowledgement stays ambiguous. */
export async function inTransaction<T>(pool: PoolLike, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let begun = false;
  // An unacknowledged BEGIN or COMMIT leaves the session state unknown.
  let discard = true;
  // The pool detaches its listener on checkout; a server-ended session must
  // fail this transaction, not the process.
  const onError = () => { discard = true; };
  client.on?.('error', onError);
  try {
    await client.query('BEGIN'); begun = true; discard = false;
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_MS}ms'`);
    const result = await fn(client);
    try { await client.query('COMMIT'); begun = false; }
    catch (error) { discard = true; begun = false; throw new CommitOutcomeUnknownError(error); }
    return result;
  } catch (error) {
    if (clientReadTimedOut(error)) discard = true;
    else if (begun) await client.query('ROLLBACK').catch(() => { discard = true; });
    throw error;
  } finally { client.release(discard); client.removeListener?.('error', onError); }
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
 * Keep a bounded, NUL-free diagnostic. Projectors must not put record content
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
  return message.replaceAll('\0', '').slice(0, 1024) || 'Projection failed';
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

