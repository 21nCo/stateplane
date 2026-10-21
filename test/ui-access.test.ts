import { expect, it } from 'vitest';
import { createHttpHandler } from '../packages/api/dist/index.js';
import { capabilities } from '../packages/contracts/dist/index.js';
import { grantExpired, grantable, issuance, issueBodyLimit } from '../app/src/lib/server/grants';
import { carry } from '../app/src/lib/paths';

const now = Date.UTC(2026, 9, 22, 12);
/** The access form as a browser posts it: listed groups, then the free-text group. */
function submitted(listed: string[], other: string, picked: (index: number) => readonly string[], days = '30') {
  const form = new FormData();
  form.append('days', days);
  for (const id of listed) form.append('collection', carry(id));
  form.append('other-collection', other);
  for (let index = 0; index <= listed.length; index++) for (const capability of picked(index)) form.append(`capabilities-${index}`, capability);
  return form;
}
const every = () => capabilities;

it('the issue form offers and sends every capability a grant can hold', () => {
  expect([...grantable].sort()).toEqual([...capabilities].sort());
  expect(capabilities).toHaveLength(11);
  const request = issuance(submitted(['items'], '', index => index === 0 ? every() : []), now);
  expect(request).toEqual({ body: { expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    grants: [{ collectionId: 'items', capabilities: [...capabilities] }] } });
  // A value outside the contract is dropped rather than sent.
  expect(issuance(submitted(['items'], '', () => ['records:everything']), now)).toEqual({ invalid: true });
});

it('a collection named in two groups gets one grant with both groups\' capabilities', () => {
  const request = issuance(submitted(['items', ' items '], 'items', index => [['claims:review'], ['records:read'], ['export:read']][index]), now);
  expect(request).toEqual({ body: expect.objectContaining({ grants: [
    { collectionId: 'items', capabilities: ['claims:review', 'export:read'] }, { collectionId: ' items ', capabilities: ['records:read'] }] }) });
});

it('an issuance is sent only when the /v1 route reads its whole body, and a larger one is refused unsent', async () => {
  let received: unknown;
  const handler = createHttpHandler({ identity: { verify: async () => ({ kind: 'session', userPrincipalId: 'owner', credentialId: 'session' }) } as never,
    services: { agents: { issue: async (_actor: unknown, _space: string, body: string) => {
      received = JSON.parse(body); return { keyId: 'key_1', secret: 'secret', expiresAt: 'x' }; } } } as never });
  const post = (body: string) => handler(new Request('https://stateplane.example/v1/spaces/sp/agent-keys',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
  // Long multibyte IDs with every capability: grow the free-text name until the body is exactly the limit.
  const listed = Array.from({ length: 96 }, (_, index) => `${'é'.repeat(30)}${index}`);
  const form = (other: string) => submitted(listed.slice(0, 40), other, every);
  const bytes = (other: string) => { const result = issuance(form(other), now);
    return 'body' in result ? new TextEncoder().encode(JSON.stringify(result.body)).byteLength : 'tooLarge' in result ? result.tooLarge.bytes : 0; };
  let other = 'x';
  while (bytes(other) < issueBodyLimit) other += 'x';
  expect(bytes(other)).toBe(issueBodyLimit);
  const maximal = issuance(form(other), now);
  if (!('body' in maximal)) throw new Error('A request at the limit is sent');
  const accepted = await post(JSON.stringify(maximal.body));
  expect(accepted.status).toBe(201);
  expect(received).toEqual(maximal.body);
  expect(maximal.body.grants).toHaveLength(41);

  const over = issuance(form(`${other}x`), now);
  expect(over).toEqual({ tooLarge: { bytes: issueBodyLimit + 1, limit: issueBodyLimit } });
  // The bound is the route's: the same request one byte longer is a size rejection no retry changes.
  const refused = await post(JSON.stringify({ ...maximal.body, grants: [...maximal.body.grants.slice(0, -1),
    { collectionId: `${other}x`, capabilities: [...capabilities] }] }));
  expect([refused.status, (await refused.json()).error]).toEqual([429, expect.objectContaining({ code: 'RATE_LIMITED', retryable: false })]);
  // The full form of 96 listed collections with every capability is refused before sending.
  expect(issuance(submitted(listed, '', every), now)).toHaveProperty('tooLarge');
});

it('a grant past its own deadline is expired while a live or non-expiring grant is not', () => {
  expect(grantExpired({ expiresAt: new Date(now - 1).toISOString() }, now)).toBe(true);
  // The authority requires expires_at > now, so the deadline instant itself is expired.
  expect(grantExpired({ expiresAt: new Date(now).toISOString() }, now)).toBe(true);
  expect(grantExpired({ expiresAt: new Date(now + 1).toISOString() }, now)).toBe(false);
  expect(grantExpired({ expiresAt: null }, now)).toBe(false);
});
