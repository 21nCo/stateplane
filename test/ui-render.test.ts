import { expect, it } from 'vitest';
import { render } from '../app/node_modules/svelte/src/server/index.js';
import Access from '../app/src/routes/spaces/[space]/access/+page.svelte';

const data = { cursor: null, paged: false, error: null, keys: { items: [], nextCursor: null }, capabilities: ['records:read'], lifetimes: [30],
  collections: ['items'], moreCollections: false, collectionsError: null };
const body = (form: object) => render(Access as never, { props: { data, form } as never }).body.replace(/<!--[^]*?-->/g, '');
const error = (retryable: boolean) => ({ code: 'PROVIDER_UNAVAILABLE', retryable, requestId: 'r' });

it('a host without agent keys is reported as not configured, never as a retry that could succeed', () => {
  for (const form of [{ issueError: error(false) }, { revokeError: error(false), revokeKeyId: 'key_1' }]) {
    const html = body(form);
    expect(html).toContain('Agent keys are not configured on this host, so no retry here can succeed.');
    expect(html).not.toContain('Try again shortly');
    expect(html).not.toContain('Retry until it finishes');
  }
  expect(body({ revokeError: error(false), revokeKeyId: 'key_1' })).toContain('Finish it from a host where agent keys are configured.');
  // A retryable outage keeps the transient guidance.
  expect(body({ issueError: error(true) })).toContain('Try again shortly');
  expect(body({ revokeError: error(true), revokeKeyId: 'key_1' })).toContain('Retry until it finishes');
});

it('each grant shows its own deadline, and one past it is marked expired while its key is active', () => {
  const grant = (collectionId: string, expiresAt: string | null, expired: boolean) => ({ collectionId, capabilities: ['records:read'], expiresAt, expired });
  const key = { keyId: 'key_1', status: 'active', expiresAt: '2026-11-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', revokedAt: null,
    providerRevokedAt: null, grants: [grant('gone', '2026-10-20T00:00:00.000Z', true), grant('live', '2026-10-30T00:00:00.000Z', false), grant('open', null, false)] };
  const html = render(Access as never, { props: { data: { ...data, keys: { items: [key], nextCursor: null } }, form: null } as never }).body
    .replace(/<!--[^]*?-->/g, '').replace(/\s+/g, ' ');
  expect(html).toContain('gone</span>: records:read <span class="text-danger">(expired <time datetime="2026-10-20T00:00:00.000Z">');
  expect(html).toContain('live</span>: records:read <span class="hint">(expires <time datetime="2026-10-30T00:00:00.000Z">');
  expect(html).toMatch(/open<\/span>: records:read <\/div>/);
});

it('the form offers every capability it is given, and an oversized issuance says nothing was sent', () => {
  const capabilities = ['records:read', 'claims:review', 'export:read'];
  const html = render(Access as never, { props: { data: { ...data, capabilities }, form: { issueTooLarge: { bytes: 16_385, limit: 16_384 } } } as never }).body;
  for (const capability of capabilities) expect(html.match(new RegExp(`value="${capability}"`, 'g'))).toHaveLength(2);
  expect(html).toContain('These grants need 16385 bytes; one key\'s issuance accepts at most 16384. Nothing was sent.');
});

it('a refused discovery check claims neither authorization nor a missing grant', () => {
  const check = { kind: 'api-key', code: null, rejected: false, space: { allowed: false, code: 'FORBIDDEN', denied: false } };
  const html = body({ check });
  expect(html).toContain('This space: not determined (FORBIDDEN).');
  expect(html).toContain('This does not confirm whether this space authorizes the key.');
  expect(html).not.toContain('authorized here');
});
