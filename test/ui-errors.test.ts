import { describe, expect, it } from 'vitest';
import { definitive, maxUnresolved, uncertain } from '../app/src/lib/errors';
import { unresolvedAfter, writeAttempt, writeClock } from '../app/src/lib/server/forms';
import { receiptRetentionSeconds, retryMarginSeconds, seal, sealSecret } from '../app/src/lib/server/receipts';

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
  const secret = sealSecret('ab'.repeat(32));
  const now = Date.UTC(2026, 9, 12, 8);
  const clock = { secret, now, by: '' };
  const submit = (fields: [string, string][]) => { const form = new FormData(); for (const [name, value] of fields) form.append(name, value); return form; };
  const write = (key: string, title: string, at = now) => seal(secret, key, JSON.stringify({ data: { title } }), at);
  const posted = (writes: { key: string; sent: string; at: string; seal: string }[]) => writes.flatMap(item =>
    [['pendingKey', item.key], ['pendingSent', item.sent], ['pendingAt', item.at], ['pendingSeal', item.seal]] as [string, string][]);
  const shown = (item: ReturnType<typeof write>) => expect.objectContaining({ key: item.key, sent: item.sent, expired: false });
  const first = write('k1', 'first'), second = write('k2', 'second');

  it('keeps a retried write after a refusal and ends it only on a receipt or a definitive result', () => {
    const retry = writeAttempt(submit([...posted([first, second]), ['retry', '1'], ['idempotencyKey', 'fresh']]), { data: { title: 'draft' } }, clock);
    expect([retry.key, retry.request, retry.refused]).toEqual(['k2', { data: { title: 'second' } }, null]);
    for (const code of ['SPACE_UNAVAILABLE', 'FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND', 'REVISION_CONFLICT', 'COMMIT_OUTCOME_UNKNOWN'])
      expect(unresolvedAfter(retry, error(code, false))).toEqual([shown(first), shown(second)]);
    expect(unresolvedAfter(retry, null)).toEqual([shown(first)]);
    expect(unresolvedAfter(retry, error('IDEMPOTENCY_MISMATCH', false))).toEqual([shown(first)]);
  });

  it('adds an uncertain new request beside earlier ones and refuses one past the bound', () => {
    const fresh = writeAttempt(submit([...posted([first]), ['idempotencyKey', 'k2']]), { data: { title: 'second' } }, clock);
    expect(unresolvedAfter(fresh, error('COMMIT_OUTCOME_UNKNOWN', false))).toEqual([shown(first), { ...second, deadline:
      new Date(now + (receiptRetentionSeconds - retryMarginSeconds) * 1000).toISOString(), expired: false, by: '', foreign: false }]);
    expect(unresolvedAfter(fresh, error('SCHEMA_INVALID', false))).toEqual([shown(first)]);
    expect(unresolvedAfter(fresh, null)).toEqual([shown(first)]);
    const writes = Array.from({ length: maxUnresolved }, (_, index) => write(`k${index}`, `t${index}`));
    expect(writeAttempt(submit([...posted(writes), ['idempotencyKey', 'k9']]), { data: {} }, clock).full).toBe(true);
    expect(writeAttempt(submit([...posted(writes), ['retry', '0']]), { data: {} }, clock).full).toBe(false);
  });

  it('forgets only the named write and sends nothing', () => {
    const forget = writeAttempt(submit([...posted([first, second]), ['forget', '0']]), { data: { title: 'draft' } }, clock);
    expect([forget.request, forget.rest]).toEqual([null, [shown(second)]]);
    // An index the page never offered names no write.
    expect(writeAttempt(submit([...posted([first]), ['retry', '']]), { data: {} }, clock).retry).toBe(false);
  });

  it('expires a write at its deadline, and a posted time cannot extend it', () => {
    const window = (receiptRetentionSeconds - retryMarginSeconds) * 1000;
    const retry = (item: ReturnType<typeof write>, at = now) => writeAttempt(submit([...posted([item]), ['retry', '0']]), null, { secret, now: at, by: '' });
    expect(retry(first, now + window).refused).toBe(null);
    expect(retry(first, now + window + 1).refused).toMatchObject({ code: 'RECEIPT_EXPIRED' });
    // An altered time, a missing stamp or another server's secret makes it expired, never later.
    for (const altered of [{ ...first, at: String(now + window) }, { ...first, seal: '' }, { ...first, at: '' },
      seal(sealSecret('cd'.repeat(32)), first.key, first.sent, now)])
      expect(retry(altered)).toMatchObject({ refused: { code: 'RECEIPT_EXPIRED' }, pending: [{ deadline: null, expired: true }] });
    expect(writeAttempt(submit(posted([first])), null, { secret: null, now, by: '' }).pending[0].expired).toBe(true);
  });

  it('retries a write only under the credential that sent it', () => {
    // A receipt belongs to the credential that sent its request; the session cookie is shared by every tab.
    const as = (token: string) => writeClock({ platform: { env: { STATEPLANE_TEST_CURSOR_SECRET: 'ab'.repeat(32) } } as never,
      cookies: { get: () => token } as never });
    const owner = as('owner-bearer'), agent = as('agent-bearer');
    const sent = writeAttempt(submit([['idempotencyKey', 'k1']]), { data: { title: 'once' } }, owner);
    const [lost] = unresolvedAfter(sent, error('COMMIT_OUTCOME_UNKNOWN', false));
    expect(JSON.stringify(lost)).not.toContain('bearer');
    const pendingBy = (item: typeof lost) => [...posted([item]), ['pendingBy', item.by]] as [string, string][];
    const retry = (item: typeof lost, clock: typeof owner) => writeAttempt(submit([...pendingBy(item), ['retry', '0']]), null, clock);
    // Under another credential it is refused unsent and stays listed, never called expired.
    expect(retry(lost, agent)).toMatchObject({ refused: { code: 'OTHER_CREDENTIAL' }, key: 'k1', pending: [{ key: 'k1', foreign: true }] });
    // Back under the credential that sent it, the same request is retried under its key.
    expect(retry(lost, owner)).toMatchObject({ refused: null, key: 'k1', request: { data: { title: 'once' } }, pending: [{ foreign: false, expired: false }] });
    // Claiming the current credential's digest cannot make another credential's seal valid.
    expect(retry({ ...lost, by: agent.by }, agent)).toMatchObject({ refused: { code: 'RECEIPT_EXPIRED' }, pending: [{ expired: true }] });
  });
});
