import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, configuredChunks, DeterministicEmbedder, embedBatch, EmbedderUnavailableError, EmbeddingRegistry,
  EmbeddingRejectedError, pointer } from '../packages/retrieval/dist/index.js';

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
});

test('the registry selects only allowed regions, then by limits, quality and cost, and resolves exact identities', () => {
  const cheapUs = profile({ embedder: 'cheap', region: 'us-east', costPerMillionCodePoints: 1, quality: 0.9 });
  const eu = profile({ embedder: 'eu-model', region: 'eu-west', costPerMillionCodePoints: 5, quality: 0.8 });
  const euBetter = profile({ embedder: 'eu-better', region: 'eu-west', costPerMillionCodePoints: 5, quality: 0.95 });
  const euShort = profile({ embedder: 'eu-short', region: 'eu-west', costPerMillionCodePoints: 0, maxInputCodePoints: 500 });
  const registry = new EmbeddingRegistry([cheapUs, eu, euBetter, euShort]);
  const needs = { regions: ['eu-west'], dimensions: [384], inputCodePoints: 1000 };
  assert.equal(registry.select(needs), euBetter, 'the cheaper US embedder is outside the policy; the short one cannot take a chunk');
  assert.equal(registry.select({ ...needs, minQuality: 0.99 }), null);
  assert.equal(registry.select({ ...needs, dimensions: [768] }), null);
  assert.equal(registry.select({ ...needs, regions: ['us-east', 'eu-west'] }), cheapUs);
  assert.equal(registry.resolve(eu.profile, ['us-east', 'eu-west'], 1000), eu);
  assert.equal(registry.resolve(eu.profile, ['us-east'], 1000), null);
  assert.equal(registry.resolve({ ...eu.profile, modelVersion: '2' }, ['eu-west'], 1000), null);
  assert.throws(() => new EmbeddingRegistry([eu, profile({ embedder: 'eu-model', region: 'eu-west' })]), /Duplicate/);
  assert.throws(() => new EmbeddingRegistry([{ profile: { ...eu.profile, region: 'EU' }, embed: eu.embed }]), /Invalid/);
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
  const rejecting = { profile: local.profile, embed: async () => { calls++; throw new Error('payload refused'); } };
  await assert.rejects(embedBatch(rejecting, ['a'], never, [1, 1]), /payload refused/);
  assert.equal(calls, 1, 'an input error is not retried');
  for (const answer of [[[1, 0, 0]], [[1, 0, 0, Number.NaN]], [[0, 0, 0, 0]], []]) {
    await assert.rejects(embedBatch({ profile: local.profile, embed: async () => answer }, ['a'], never), EmbeddingRejectedError);
  }
  await assert.rejects(embedBatch(local, ['a', 'b', 'c'], never), RangeError);
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
