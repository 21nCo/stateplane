import type { ApplicationPorts } from '@stateplane/application';
import type { RecordRef, Revision } from '@stateplane/contracts';
export interface ProjectionJob { ref: RecordRef; revision: Revision; generation: number; }
export interface ProjectionWorker { run(job: ProjectionJob, services: ApplicationPorts): Promise<void>; }

/** A delivery hint names one lease. It carries no record content and grants nothing. */
export interface DeliveryMessage { eventId: string; attempt: number }
export type DeliveryOutcome = 'applied' | 'superseded' | 'requeued' | 'lost' | 'failed' | 'released';
/** The cell's SQL outbox remains the only durable job authority. */
export interface OutboxStore {
  claim(limits?: { limit?: number; perSpace?: number; pairs?: number; leaseSeconds?: number }): Promise<DeliveryMessage[]>;
  release(messages: readonly DeliveryMessage[]): Promise<number>;
  stepReconciliations(jobs?: number, pageSize?: number): Promise<number>;
}
/** At-least-once transport, such as a Cloudflare Queue producer. */
export interface DeliveryTransport { send(messages: readonly DeliveryMessage[]): Promise<void> }
export interface DispatchResult { claimed: number; sent: number; released: number; error?: unknown }

/**
 * One dispatcher tick. A failed send releases every lease from the batch:
 * any hint that did arrive names a released attempt and is fenced as lost.
 * A crash before release leaves unstarted leases to expire and be reclaimed.
 */
export async function dispatch(store: OutboxStore, transport: DeliveryTransport,
  limits?: Parameters<OutboxStore['claim']>[0]): Promise<DispatchResult> {
  const messages = await store.claim(limits);
  if (!messages.length) return { claimed: 0, sent: 0, released: 0 };
  try {
    await transport.send(messages);
    return { claimed: messages.length, sent: messages.length, released: 0 };
  } catch (error) {
    return { claimed: messages.length, sent: 0, released: await store.release(messages), error };
  }
}

/** Accept only the exact hint shape; anything else is dropped, never trusted. */
export function parseDeliveryMessage(body: unknown): DeliveryMessage | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  const { eventId, attempt } = body as Record<string, unknown>;
  if (keys.length !== 2 || typeof eventId !== 'string' || !/^evt_[0-9a-f-]{36}$/.test(eventId) ||
    !Number.isSafeInteger(attempt) || (attempt as number) < 1) return null;
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
