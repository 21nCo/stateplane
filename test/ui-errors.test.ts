import { expect, it } from 'vitest';
import { uncertain } from '../app/src/lib/errors';

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
