import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, configuredChunks, DeterministicEmbedder, embedBatch, EmbedderFailedError, EmbedderUnavailableError, EmbeddingRegistry,
  EmbeddingRejectedError, fuseRanks, pointer, RRF_K } from '../packages/retrieval/dist/index.js';

const never = new AbortController().signal;
const profile = (overrides = {}) => new DeterministicEmbedder(overrides);

test('chunks keep code-point offsets exact, cut at whitespace and overlap', () => {
  const text = `${'word '.repeat(300)}😀 tail`;
  const chunks = chunkText(text, '/body', 400, 40);
  const points = Array.from(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(chunk.content, points.slice(chunk.start, chunk.end).join(''));
    assert.ok(chunk.end - chunk.start <= 400);
    assert.equal(chunk.field, '/body');
  }
  // Each cut falls just after whitespace, and the next chunk starts 40 code points earlier.
  for (let i = 1; i < chunks.length; i++) {
    assert.match(points[chunks[i - 1].end - 1], /\s/);
    assert.equal(chunks[i].start, chunks[i - 1].end - 40);
  }
  assert.equal(chunks.at(-1).end, points.length, 'the astral character counts as one code point');
  assert.deepEqual(chunkText('   ', null), []);
  // U+0000 and an unpaired surrogate, which PostgreSQL text cannot hold, become U+FFFD one for one.
  assert.deepEqual(chunkText('a\u0000b \ud800c\u{1F600}', null), [{ field: null, start: 0, end: 7, content: 'a\uFFFDb \uFFFDc\u{1F600}' }]);
  assert.throws(() => chunkText('x', null, 10, 5), RangeError);
});

test('only configured record fields, source content and claim statements are chunked', () => {
  const record = JSON.stringify({ secret: 'classified plan', tags: ['a'], title: 'Bridge opening', count: 3, 'a/b': { '~k': 'nested' } });
  const policy = { recordFields: ['/title', '/count', '/missing', '/a~1b/~0k'], sourceContent: false, claimStatements: false };
  assert.deepEqual(configuredChunks('record', policy, record).map(chunk => [chunk.field, chunk.content]),
    [['/title', 'Bridge opening'], ['/a~1b/~0k', 'nested']]);
  assert.deepEqual(configuredChunks('record', { ...policy, recordFields: [] }, record), []);
  assert.deepEqual(configuredChunks('source', policy, 'extracted text'), []);
  assert.deepEqual(configuredChunks('claim', { ...policy, claimStatements: true }, 'A statement').map(chunk => chunk.content), ['A statement']);
  assert.equal(pointer({ list: ['x', 'y'] }, '/list/1'), 'y');
  assert.equal(pointer({ list: ['x'] }, '/list/01'), undefined);
  assert.equal(pointer({ constructor: 1 }, '/toString'), undefined, 'inherited properties are not fields');
  assert.equal(pointer({ title: 'x' }, 'title'), undefined, 'a pointer without its leading slash is malformed');
  // Every ~ must start ~0 or ~1; ~01 decodes to ~1, not /.
  for (const malformed of ['/a~2', '/a~', '/~', '/a~/b', '/a~~0']) assert.equal(pointer({ 'a~2': 'x', 'a~': 'y', '~': 'z', a: { b: 'w' } }, malformed), undefined, malformed);
  assert.equal(pointer({ 'a~1': 'x' }, '/a~01'), 'x');
  assert.equal(pointer({ 'a/b': 'x' }, '/a~1b'), 'x');
  assert.deepEqual(pointer({ a: 1 }, ''), { a: 1 }, 'the empty pointer is the whole document');
});

test('the registry selects only allowed regions, then by limits, quality and cost, and resolves exact identities', () => {
  const cheapUs = profile({ embedder: 'cheap', region: 'us-east', costPerMillionCodePoints: 1, quality: 0.9 });
  const eu = profile({ embedder: 'eu-model', region: 'eu-west', costPerMillionCodePoints: 5, quality: 0.8 });
  const euBetter = profile({ embedder: 'eu-better', region: 'eu-west', costPerMillionCodePoints: 5, quality: 0.95 });
  const euShort = profile({ embedder: 'eu-short', region: 'eu-west', costPerMillionCodePoints: 0, maxInputCodePoints: 500 });
  const registry = new EmbeddingRegistry([cheapUs, eu, euBetter, euShort]);
  // The registry hands out snapshots of what it validated, so compare by name.
  const name = embedder => embedder?.profile.embedder ?? null;
  const needs = { regions: ['eu-west'], dimensions: [384], inputCodePoints: 1000 };
  assert.equal(name(registry.select(needs)), 'eu-better', 'the cheaper US embedder is outside the policy; the short one cannot take a chunk');
  assert.equal(registry.select({ ...needs, minQuality: 0.99 }), null);
  assert.equal(registry.select({ ...needs, dimensions: [768] }), null);
  assert.equal(name(registry.select({ ...needs, regions: ['us-east', 'eu-west'] })), 'cheap');
  assert.equal(name(registry.resolve(eu.profile, ['us-east', 'eu-west'], 1000)), 'eu-model');
  assert.equal(registry.resolve(eu.profile, ['eu-west'], 1000), registry.resolve(eu.profile, ['eu-west'], 1000), 'one snapshot per embedder');
  assert.equal(registry.resolve(eu.profile, ['us-east'], 1000), null);
  assert.equal(registry.resolve({ ...eu.profile, modelVersion: '2' }, ['eu-west'], 1000), null);
  assert.throws(() => new EmbeddingRegistry([eu, profile({ embedder: 'eu-model', region: 'eu-west' })]), /Duplicate/);
  assert.throws(() => new EmbeddingRegistry([{ profile: { ...eu.profile, region: 'EU' }, embed: eu.embed }]), /Invalid/);
});

test('the registry keeps what it validated: changing a profile afterwards changes no selection, region or limit', async () => {
  const local = profile({ embedder: 'mutable', region: 'eu-west', maxBatch: 2 });
  const source = { ...local.profile };
  const calls = [];
  const mutable = { profile: source, embed(texts, signal) { calls.push(this === mutable); return local.embed(texts, signal); } };
  const registry = new EmbeddingRegistry([mutable]);
  const needs = { regions: ['eu-west'], dimensions: [384], inputCodePoints: 1000 };
  const chosen = registry.select(needs);
  // A later edit of the original object: another region, model, batch size and dimensions.
  Object.assign(source, { region: 'us-east', modelVersion: '9', maxBatch: 2048, dimensions: 768, maxInputCodePoints: 10 });
  assert.equal(registry.resolve(local.profile, ['us-east'], 1000), null, 'the edited region is not authorized');
  assert.equal(registry.select({ ...needs, regions: ['us-east'] }), null);
  const resolved = registry.resolve(local.profile, ['eu-west'], 1000);
  assert.equal(resolved, chosen, 'the validated identity, region and input limit still resolve');
  assert.deepEqual(resolved.profile, local.profile);
  assert.ok(Object.isFrozen(resolved) && Object.isFrozen(resolved.profile));
  assert.throws(() => { resolved.profile.region = 'us-east'; }, TypeError);
  await assert.rejects(embedBatch(resolved, ['a', 'b', 'c'], never), RangeError, 'the validated batch limit still applies');
  // The adapter's own profile no longer matches what was authorized, so it is not called at all.
  await assert.rejects(embedBatch(resolved, ['a', 'b'], never, []), EmbedderUnavailableError);
  assert.deepEqual(calls, []);
  Object.assign(source, local.profile);
  assert.equal((await embedBatch(resolved, ['a', 'b'], never)).length, 2);
  assert.deepEqual(calls, [true], 'embed runs on the registered embedder once its profile matches again');
});

test('an adapter whose own profile changes after registration is refused before it is called', async () => {
  const needs = { regions: ['eu-west'], dimensions: [384], inputCodePoints: 1000 };
  // An adapter that, like a real provider client, sends whatever its own profile says.
  const adapter = () => {
    const local = profile({ embedder: 'self-reading', region: 'eu-west' });
    const seen = [];
    const embedder = { profile: { ...local.profile },
      embed(texts, signal) { seen.push(`${this.profile.region}/${this.profile.modelVersion}`); return local.embed(texts, signal); } };
    return { local, seen, embedder, resolved: new EmbeddingRegistry([embedder]).select(needs) };
  };
  const refused = error => error instanceof EmbedderUnavailableError && error.cause === undefined;
  // (a) The original profile is edited to another region and model version.
  const edited = adapter();
  Object.assign(edited.embedder.profile, { region: 'us-east', modelVersion: '2' });
  assert.deepEqual(edited.resolved.profile, edited.local.profile, 'the authorized snapshot is unchanged');
  await assert.rejects(embedBatch(edited.resolved, ['a'], never, []), refused);
  assert.deepEqual(edited.seen, [], 'the adapter never ran under the edited profile');
  // (b) The profile object is replaced; then (c) a getter that throws.
  const replaced = adapter();
  replaced.embedder.profile = { ...replaced.local.profile, region: 'us-east' };
  await assert.rejects(embedBatch(replaced.resolved, ['a'], never, []), refused);
  assert.deepEqual(replaced.seen, []);
  const throwing = adapter();
  Object.defineProperty(throwing.embedder, 'profile', { get() { throw new Error('profile unavailable'); } });
  await assert.rejects(embedBatch(throwing.resolved, ['a'], never, []), refused);
  assert.deepEqual(throwing.seen, []);
  // A field getter or a proxy trap that throws refuses the same way, always as a rejection, never as the input's failure.
  for (const unreadable of [
    embedder => Object.defineProperty(embedder.profile, 'region', { get() { throw new Error('boom'); } }),
    embedder => { embedder.profile = new Proxy({ ...embedder.profile }, { get() { throw new Error('trap'); } }); }]) {
    const broken = adapter();
    unreadable(broken.embedder);
    let pending;
    assert.doesNotThrow(() => { pending = broken.resolved.embed(['a'], never); });
    await assert.rejects(pending, error => error instanceof EmbedderUnavailableError);
    await assert.rejects(embedBatch(broken.resolved, ['a'], never, []), refused);
    assert.deepEqual(broken.seen, []);
  }
  // Every field counts, a limit as much as the region.
  const limit = adapter();
  limit.embedder.profile.maxBatch = 7;
  await assert.rejects(embedBatch(limit.resolved, ['a'], never, []), refused);
  assert.deepEqual(limit.seen, []);
  // An adapter left as registered embeds under the authorized profile.
  const kept = adapter();
  assert.equal((await embedBatch(kept.resolved, ['a', 'b'], never, [])).length, 2);
  assert.deepEqual(kept.seen, ['eu-west/1']);
});

test('a batch retries an outage within bounds and rejects malformed vectors as the input', async () => {
  const local = profile({ dimensions: 4, maxBatch: 2 });
  let calls = 0;
  const flaky = { profile: local.profile, embed: async (texts, signal) => {
    if (++calls < 3) throw new EmbedderUnavailableError();
    return local.embed(texts, signal);
  } };
  assert.equal((await embedBatch(flaky, ['a', 'b'], never, [1, 1])).length, 2);
  assert.equal(calls, 3);
  calls = 0;
  const down = { profile: local.profile, embed: async () => { calls++; throw new EmbedderUnavailableError(); } };
  await assert.rejects(embedBatch(down, ['a'], never, [1, 1]), EmbedderUnavailableError);
  assert.equal(calls, 3, 'three tries, then the outage surfaces');
  calls = 0;
  const rejecting = { profile: local.profile, embed: async texts => { calls++; throw new Error(`payload refused: ${texts[0]}`); } };
  await assert.rejects(embedBatch(rejecting, ['secret text'], never, [1, 1]), error => error instanceof EmbedderFailedError
    && !error.message.includes('secret') && error.cause === undefined);
  assert.equal(calls, 1, 'an input error is not retried');
  // An outage keeps only its category too, and the caller decides what else is an outage.
  const quoting = { profile: local.profile, embed: async texts => { calls++;
    throw Object.assign(new Error(`socket reset sending ${texts[0]}`), { code: 'ECONNRESET' }); } };
  calls = 0;
  await assert.rejects(embedBatch(quoting, ['secret text'], never, [1, 1], undefined, error => error.code === 'ECONNRESET'),
    error => error instanceof EmbedderUnavailableError && !error.message.includes('secret') && error.cause === undefined);
  assert.equal(calls, 3, 'an outage by the caller\'s classification is retried');
  calls = 0;
  await assert.rejects(embedBatch(quoting, ['secret text'], never, [1, 1]), EmbedderFailedError);
  assert.equal(calls, 1, 'by default only EmbedderUnavailableError is an outage');
  for (const answer of [[[1, 0, 0]], [[1, 0, 0, Number.NaN]], [[0, 0, 0, 0]], []]) {
    await assert.rejects(embedBatch({ profile: local.profile, embed: async () => answer }, ['a'], never), EmbeddingRejectedError);
  }
  await assert.rejects(embedBatch(local, ['a', 'b', 'c'], never), RangeError);

  // `admit` runs before every call, retries included; once it throws, nothing more is sent.
  calls = 0;
  const admitted = [];
  const narrowed = new Error('region no longer allowed');
  const admit = async () => { admitted.push(calls); if (calls === 1) throw narrowed; };
  await assert.rejects(embedBatch(down, ['a'], never, [1, 1], admit), error => error === narrowed);
  assert.deepEqual([calls, admitted], [1, [0, 1]]);
  calls = 0;
  admitted.length = 0;
  assert.equal((await embedBatch(flaky, ['a'], never, [1, 1], async () => { admitted.push(calls); })).length, 1);
  assert.deepEqual(admitted, [0, 1, 2], 'checked before the first call and before each retry');
});

test('the deterministic embedder is stable, normalized and closer for shared words', async () => {
  const embedder = profile();
  const [a, b, c, empty] = await embedder.embed(['Bridge opened in 1932', 'bridge OPENED', 'tax filing deadline', '...'], never);
  assert.deepEqual(a, embedder.vector('Bridge opened in 1932'));
  const dot = (x, y) => x.reduce((sum, value, i) => sum + value * y[i], 0);
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-9);
  assert.ok(dot(a, b) > dot(a, c));
  assert.equal(empty.filter(value => value !== 0).length, 1, 'text without words still has a nonzero vector');
});

test('reciprocal rank fusion favours keys both lists rank, counts a key once per list and orders ties deterministically', () => {
  const fused = fuseRanks([['a', 'b', 'a', 'c'], ['b', 'd', 'b']]);
  // b: 1/62 + 1/61 beats a: 1/61; a repeated chunk keeps its best rank and adds nothing.
  assert.deepEqual(fused.map(entry => [entry.key, entry.ranks]), [['b', [2, 1]], ['a', [1, null]], ['d', [null, 2]], ['c', [3, null]]]);
  assert.equal(fused[0].score, 1 / (RRF_K + 2) + 1 / (RRF_K + 1));
  // Equal scores: the better best rank, then the earlier list, then the key.
  assert.deepEqual(fuseRanks([['y', 'x'], ['z', 'w']]).map(entry => entry.key), ['y', 'z', 'x', 'w']);
  assert.deepEqual(fuseRanks([['q'], []]), [{ key: 'q', score: 1 / (RRF_K + 1), ranks: [1, null] }]);
  assert.deepEqual(fuseRanks([]), []);
  assert.throws(() => fuseRanks([['a']], -1), RangeError);
});
