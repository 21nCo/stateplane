import { describe, expect, it } from 'vitest';
import { definitive, maxUnresolved, uncertain } from '../app/src/lib/errors';
import { unresolvedAfter, writeAttempt } from '../app/src/lib/server/forms';

const error = (code: string, retryable: boolean) => ({ code, retryable, requestId: null });

it('offers an unchanged retry only when the write outcome is unknown', () => {
  for (const retryable of [false, true]) {
    expect(uncertain(error('COMMIT_OUTCOME_UNKNOWN', retryable))).toBe(true);
    expect(uncertain(error('PROVIDER_UNAVAILABLE', retryable))).toBe(true);
    expect(uncertain(error('RECEIPT_PENDING', retryable))).toBe(true);
    expect(uncertain(error('SCHEMA_INVALID', retryable))).toBe(false);
  }
  // A size rejection happens before any write; only a time or capacity limit is retryable.
  expect(uncertain(error('RATE_LIMITED', false))).toBe(false);
  expect(uncertain(error('RATE_LIMITED', true))).toBe(true);
  expect(uncertain(null)).toBe(false);
});

it('ends a retried write only on a result that its key can never recover from', () => {
  expect(definitive(error('IDEMPOTENCY_MISMATCH', false))).toBe(true);
  // Refusals that can come before the key is looked up, or after its receipt expired.
  for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'SPACE_UNAVAILABLE', 'STALE_PLACEMENT', 'RATE_LIMITED',
    'BACKPRESSURE', 'INVALID_ARGUMENT', 'SCHEMA_INVALID', 'REVISION_CONFLICT', 'UNIQUE_CONFLICT', 'KEY_RESERVED',
    'RECEIPT_EXPIRED', 'COMMIT_OUTCOME_UNKNOWN', 'PROVIDER_UNAVAILABLE', 'RECEIPT_PENDING'])
    for (const retryable of [false, true]) expect(definitive(error(code, retryable))).toBe(false);
});

describe('unresolved writes', () => {
  const submit = (fields: [string, string][]) => { const form = new FormData(); for (const [name, value] of fields) form.append(name, value); return form; };
  const write = (key: string, title: string) => ({ key, sent: JSON.stringify({ data: { title } }) });
  const posted = (writes: { key: string; sent: string }[]) => writes.flatMap(item => [['pendingKey', item.key], ['pendingSent', item.sent]] as [string, string][]);
  const first = write('k1', 'first'), second = write('k2', 'second');

  it('keeps a retried write after a refusal and ends it only on a receipt or a definitive result', () => {
    const retry = writeAttempt(submit([...posted([first, second]), ['retry', '1'], ['idempotencyKey', 'fresh']]), { data: { title: 'draft' } });
    expect([retry.key, retry.request]).toEqual(['k2', { data: { title: 'second' } }]);
    for (const code of ['SPACE_UNAVAILABLE', 'FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND', 'REVISION_CONFLICT', 'COMMIT_OUTCOME_UNKNOWN'])
      expect(unresolvedAfter(retry, error(code, false))).toEqual([first, second]);
    expect(unresolvedAfter(retry, null)).toEqual([first]);
    expect(unresolvedAfter(retry, error('IDEMPOTENCY_MISMATCH', false))).toEqual([first]);
  });

  it('adds an uncertain new request beside earlier ones and refuses one past the bound', () => {
    const fresh = writeAttempt(submit([...posted([first]), ['idempotencyKey', 'k2']]), { data: { title: 'second' } });
    expect(unresolvedAfter(fresh, error('COMMIT_OUTCOME_UNKNOWN', false))).toEqual([first, second]);
    expect(unresolvedAfter(fresh, error('SCHEMA_INVALID', false))).toEqual([first]);
    expect(unresolvedAfter(fresh, null)).toEqual([first]);
    const writes = Array.from({ length: maxUnresolved }, (_, index) => write(`k${index}`, `t${index}`));
    expect(writeAttempt(submit([...posted(writes), ['idempotencyKey', 'k9']]), { data: {} }).full).toBe(true);
    expect(writeAttempt(submit([...posted(writes), ['retry', '0']]), { data: {} }).full).toBe(false);
  });

  it('forgets only the named write and sends nothing', () => {
    const forget = writeAttempt(submit([...posted([first, second]), ['forget', '0']]), { data: { title: 'draft' } });
    expect([forget.request, forget.rest]).toEqual([null, [second]]);
    // An index the page never offered names no write.
    expect(writeAttempt(submit([...posted([first]), ['retry', '']]), { data: {} }).retry).toBe(false);
  });
});
