import type { ApplicationPorts } from '@stateplane/application';
import { MAX_DELIVERY_ATTEMPT } from '@stateplane/contracts';
import type { RecordRef, Revision } from '@stateplane/contracts';
export interface ProjectionJob { ref: RecordRef; revision: Revision; generation: number; }
export interface ProjectionWorker { run(job: ProjectionJob, services: ApplicationPorts): Promise<void>; }

/** A delivery hint names one lease. It carries no record content and grants nothing. */
export interface DeliveryMessage { eventId: string; attempt: number }
export type DeliveryOutcome = 'applied' | 'superseded' | 'requeued' | 'lost' | 'failed' | 'released';
/**
 * One claim's leases and how far its walk over live space/collection pairs
 * got: `whole` visited every pair, `wrapped` began at or passed the start of
 * the pair order, `partial` did neither. `parked` counts rows moved to the
 * dead letter instead of leased. `full` means the cell's unstarted leases
 * reached their in-flight bound.
 */
export interface ClaimResult { messages: DeliveryMessage[]; scan: 'whole' | 'wrapped' | 'partial'; parked?: number; full?: boolean }
/**
 * A hard end for one store call, in epoch ms (`Date.now`): the store sends
 * no statement after it, abandons one still running then and rejects.
 */
export interface StoreBound { deadline: number }
/** The cell's SQL outbox remains the only durable job authority. */
export interface OutboxStore {
  claim(limits?: { limit?: number; perSpace?: number; pairs?: number; leaseSeconds?: number; inFlight?: number },
    bound?: StoreBound): Promise<ClaimResult>;
  release(messages: readonly DeliveryMessage[], bound?: StoreBound): Promise<number>;
  /** Bounded, a step the deadline cuts short ends the call instead of failing it. */
  stepReconciliations(jobs?: number, pageSize?: number, bound?: StoreBound): Promise<number>;
}
/** At-least-once transport, such as a Cloudflare Queue producer. */
export interface DeliveryTransport { send(messages: readonly DeliveryMessage[]): Promise<void> }
export interface DispatchResult { claimed: number; sent: number; released: number; parked: number; batches: number; error?: unknown }
export interface DispatchOptions {
  limits?: NonNullable<Parameters<OutboxStore['claim']>[0]>;
  /** Keep claiming and sending until a full pass finds nothing due or this wall-clock budget is spent. 0 claims once. */
  budgetMs?: number;
  /**
   * A hard end, in epoch ms (`Date.now`), for the batch in flight: claims and
   * releases are bounded by it, a claim it cuts short ends dispatch, and a
   * send still running then is abandoned with its leases kept.
   */
  deadline?: number;
  now?: () => number;
}

/** A send the dispatch deadline cut short: it may still arrive, so its leases are kept, to be started or to expire. */
export class DispatchDeadlineError extends Error {
  constructor(message = 'Queue send outlived the dispatch deadline') { super(message); this.name = 'DispatchDeadlineError'; }
}

/** Settle with `pending`, or reject at `bound`'s deadline, leaving `pending` to run on unobserved. */
function within<T>(pending: Promise<T>, bound: StoreBound | undefined): Promise<T> {
  if (!bound) return pending;
  pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DispatchDeadlineError()), Math.max(0, bound.deadline - Date.now()));
  });
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer));
}

/**
 * One dispatcher tick: repeated claim-and-send batches within a bounded
 * budget. Each claim rotates service across spaces, so a long tick cannot
 * serve one backlog ahead of everyone else. A claim that leased or parked
 * rows made progress. One that did neither may only have walked pairs with
 * nothing due, so the tick ends early only once a run of such claims has
 * covered every pair: one whole scan, or passing the start of the pair order
 * twice. It also ends once the cell's unstarted leases reach their in-flight
 * bound, so dispatch never runs ahead of consumers by more than that,
 * however long a backlog is. A failed send releases every
 * lease from its batch that no worker has started and ends the tick; a hint
 * that arrives later finds no lease and is fenced as lost. A crash before release leaves
 * unstarted leases to expire and be reclaimed. With a `deadline`, nothing
 * outlives it: a claim cut short ends the tick, a claim that returns after
 * it sends nothing and fails the tick with its leases kept, a send cut short
 * keeps its leases (its hints may still arrive) and fails the tick, and a
 * release cut short leaves its leases to expire.
 */
export async function dispatch(store: OutboxStore, transport: DeliveryTransport,
  options: DispatchOptions = {}): Promise<DispatchResult> {
  const budgetMs = options.budgetMs ?? 0;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 0 || budgetMs > 600_000) throw new RangeError('Invalid dispatch budget');
  const now = options.now ?? Date.now;
  const until = now() + budgetMs;
  const result: DispatchResult = { claimed: 0, sent: 0, released: 0, parked: 0, batches: 0 };
  const bound = options.deadline === undefined ? undefined : { deadline: options.deadline };
  const over = () => bound !== undefined && Date.now() >= bound.deadline;
  let starts = 0;
  do {
    if (over()) break;
    let claim: ClaimResult;
    // Leases a claim cut short may have committed expire unstarted.
    try { claim = await store.claim(options.limits, bound); }
    catch (error) { if (over()) break; throw error; }
    const { messages, scan, parked = 0, full } = claim;
    result.parked += parked;
    if (messages.length || parked) starts = 0;
    else if (scan === 'whole' || (scan === 'wrapped' && ++starts === 2)) break;
    if (!messages.length) {
      if (full) break;
      continue;
    }
    result.claimed += messages.length;
    result.batches++;
    // A claim that returned after the deadline sends nothing: its leases are kept, to expire unstarted.
    if (over()) return { ...result, error: new DispatchDeadlineError('Claimed leases reached the dispatch deadline unsent') };
    try { await within(transport.send(messages), bound); }
    catch (error) {
      if (error instanceof DispatchDeadlineError) return { ...result, error };
      try { result.released += await store.release(messages, bound); }
      catch (releaseError) { if (!over()) throw releaseError; }
      return { ...result, error };
    }
    result.sent += messages.length;
    if (full) break;
  } while (now() < until);
  return result;
}

/** Accept only the exact hint shape; anything else is dropped, never trusted. */
export function parseDeliveryMessage(body: unknown): DeliveryMessage | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  const { eventId, attempt } = body as Record<string, unknown>;
  if (keys.length !== 2 || typeof eventId !== 'string' || !/^evt_[0-9a-f-]{36}$/.test(eventId) ||
    !Number.isSafeInteger(attempt) || (attempt as number) < 1 || (attempt as number) > MAX_DELIVERY_ATTEMPT) return null;
  return { eventId, attempt: attempt as number };
}

export type ConsumedOutcome = DeliveryOutcome | 'malformed' | 'retry';

/**
 * Process a delivered batch with bounded concurrency. Items are independent:
 * a poison item records its own failure, and an infrastructure error asks the
 * transport to redeliver only that hint. The SQL lease still bounds recovery.
 */
export async function consume(bodies: readonly unknown[], process: (message: DeliveryMessage) => Promise<DeliveryOutcome>,
  concurrency = 4): Promise<ConsumedOutcome[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new RangeError('Invalid concurrency');
  const results: ConsumedOutcome[] = new Array(bodies.length);
  let next = 0;
  const run = async () => {
    while (next < bodies.length) {
      const index = next++;
      const message = parseDeliveryMessage(bodies[index]);
      if (!message) { results[index] = 'malformed'; continue; }
      try { results[index] = await process(message); }
      catch { results[index] = 'retry'; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, bodies.length) }, run));
  return results;
}
