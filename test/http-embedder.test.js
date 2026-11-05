import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { embedBatch, EmbedderFailedError, EmbedderUnavailableError } from '../packages/retrieval/dist/index.js';
import { infrastructureFault } from '../packages/postgres/dist/faults.js';

// The provider-sandbox embedder of the retrieval evaluation, against a local OpenAI-compatible endpoint.
test('the evaluation HTTP embedder orders vectors by index and keeps provider text out of its errors', async t => {
  let answer = null;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    if (answer.fault) {
      // 200 headers and part of a longer body, then the transport fails it: a reset, a closed connection or a stall.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
      res.write('{"data":[{"index":0,"embedding":[0.1,"secret');
      if (answer.fault === 'rst') setTimeout(() => res.socket.resetAndDestroy(), 20);
      if (answer.fault === 'close') setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.location ? { location: answer.location } : {}) });
    res.end(answer.raw ?? JSON.stringify(answer.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  // A redirect's destination: it must never receive an input.
  const redirected = [];
  const elsewhere = createServer((req, res) => { redirected.push(req.method); res.writeHead(200).end('{"data":[]}'); });
  elsewhere.listen(0, '127.0.0.1'); await once(elsewhere, 'listening');
  t.after(() => elsewhere.close());
  // The default region is asserted, so an inherited one must not leak in.
  delete process.env.STATEPLANE_EVAL_EMBEDDINGS_REGION;
  Object.assign(process.env, { STATEPLANE_EVAL_EMBEDDINGS_URL: `http://127.0.0.1:${server.address().port}/v1/embeddings`,
    STATEPLANE_EVAL_EMBEDDINGS_MODEL: 'sandbox-model', STATEPLANE_EVAL_EMBEDDINGS_DIMENSIONS: '384', STATEPLANE_EVAL_EMBEDDINGS_KEY: 'sandbox-key' });
  const { default: embedder } = await import('../scripts/http-embedder.mjs');
  assert.deepEqual([embedder.profile.embedder, embedder.profile.dimensions, embedder.profile.region], ['eval-http', 384, 'sandbox']);
  const unit = i => Array.from({ length: 384 }, (_, j) => (j === i ? 1 : 0));
  answer = { status: 200, body: { data: [{ index: 1, embedding: unit(1) }, { index: 0, embedding: unit(0) }] } };
  assert.deepEqual(await embedBatch(embedder, ['a', 'b'], AbortSignal.timeout(5_000)), [unit(0), unit(1)]);
  assert.deepEqual(requests[0], { authorization: 'Bearer sandbox-key', body: { model: 'sandbox-model', input: ['a', 'b'], dimensions: 384 } });
  answer = { status: 503, body: { error: 'overloaded while embedding secret input' } };
  await assert.rejects(embedder.embed(['secret input'], AbortSignal.timeout(5_000)), error =>
    error instanceof EmbedderUnavailableError && !error.message.includes('secret'));
  answer = { status: 400, body: { error: 'cannot embed secret input' } };
  await assert.rejects(embedBatch(embedder, ['secret input'], AbortSignal.timeout(5_000)), EmbedderFailedError);
  answer = { status: 200, body: { data: [{ index: 0, embedding: unit(0) }] } };
  await assert.rejects(embedBatch(embedder, ['a', 'b'], AbortSignal.timeout(5_000)), 'a missing vector is refused');
  // A valid reply in any order is placed by index, for a direct caller as for embedBatch.
  answer = { status: 200, body: { data: [{ index: 1, embedding: unit(1) }, { index: 0, embedding: unit(0) }] } };
  assert.deepEqual(await embedder.embed(['a', 'b'], AbortSignal.timeout(5_000)), [unit(0), unit(1)]);
  // Exactly one vector of the configured dimensions of finite numbers per input, by index: every other reply is the
  // provider's malformed answer, refused (not an outage) with an error that quotes none of it, never returned in part.
  const v = unit(0);
  const withValue = value => v.map((x, i) => (i === 7 ? value : x));
  const malformed = {
    'null embedding': { data: [{ index: 0, embedding: null }, { index: 1, embedding: v }] },
    'missing embedding': { data: [{ index: 0 }, { index: 1, embedding: v }] },
    'string embedding': { data: [{ index: 0, embedding: 'secret' }, { index: 1, embedding: v }] },
    'object embedding': { data: [{ index: 0, embedding: { 0: 1 } }, { index: 1, embedding: v }] },
    'short embedding': { data: [{ index: 0, embedding: [0.1, 0.2] }, { index: 1, embedding: v }] },
    'long embedding': { data: [{ index: 0, embedding: [...v, 0] }, { index: 1, embedding: v }] },
    'string value': { data: [{ index: 0, embedding: withValue('secret') }, { index: 1, embedding: v }] },
    'null value': { data: [{ index: 0, embedding: v }, { index: 1, embedding: withValue(null) }] },
    'infinite value': { raw: `{"data":[{"index":0,"embedding":[${withValue('1e999')}]},{"index":1,"embedding":[${v}]}]}` },
    'repeated index after a null copy': { data: [{ index: 0, embedding: null }, { index: 0, embedding: v }] },
    'repeated valid index': { data: [{ index: 0, embedding: v }, { index: 0, embedding: v }] },
    'extra vector': { data: [{ index: 0, embedding: v }, { index: 1, embedding: v }, { index: 1, embedding: v }] },
    'missing vector': { data: [{ index: 0, embedding: v }] },
    'out-of-range index': { data: [{ index: 0, embedding: v }, { index: 2, embedding: v }] },
    'negative index': { data: [{ index: -1, embedding: v }, { index: 0, embedding: v }] },
    'fractional index': { data: [{ index: 0, embedding: v }, { index: 0.5, embedding: v }] },
    'string index': { data: [{ index: 0, embedding: v }, { index: '1', embedding: v }] },
    'missing index': { data: [{ index: 0, embedding: v }, { embedding: v }] },
    'null item': { data: [{ index: 0, embedding: v }, null] },
    'object data': { data: { 0: v, 1: v } },
    'no data': { error: 'secret' },
    'not JSON': { raw: 'secret is not JSON' },
  };
  const generic = new Set(['Embedding provider answered with the wrong number of vectors',
    'Embedding provider answered with a missing, repeated or out-of-range index', 'Embedding provider answered with a malformed reply']);
  for (const [shape, reply] of Object.entries(malformed)) {
    answer = reply.raw ? { status: 200, raw: reply.raw } : { status: 200, body: reply };
    const outcome = await embedder.embed(['a', 'b'], AbortSignal.timeout(5_000)).then(vectors => ({ vectors }), error => ({ error }));
    assert.ok(outcome.error, `${shape}: refused, not answered as ${JSON.stringify(outcome.vectors)?.slice(0, 40)}`);
    assert.ok(!(outcome.error instanceof EmbedderUnavailableError) && generic.has(outcome.error.message), `${shape}: ${outcome.error.message}`);
  }
  // A provider timeout (408) is an outage that embedBatch retries, not a refused input.
  answer = { status: 408, body: { error: 'timed out on secret input' } };
  await assert.rejects(embedder.embed(['secret input'], AbortSignal.timeout(5_000)), error =>
    error instanceof EmbedderUnavailableError && !error.message.includes('secret'));
  // A reply the transport interrupts after its headers is an outage carrying its transport cause, never the
  // malformed refusal: a direct caller sees EmbedderUnavailableError, and embedBatch, with the projection worker's own
  // outage test or its default, retries it and ends unavailable rather than counting the input as failed.
  const workerOutage = error => error instanceof EmbedderUnavailableError || infrastructureFault(error);
  for (const fault of ['rst', 'close', 'stall']) {
    answer = { fault };
    const bound = () => AbortSignal.timeout(fault === 'stall' ? 200 : 5_000);
    const direct = await embedder.embed(['secret input'], bound()).then(() => null, error => error);
    assert.ok(direct instanceof EmbedderUnavailableError, `${fault}: ${direct?.name} ${direct?.message}`);
    assert.ok(direct.cause instanceof Error && !direct.message.includes('secret'), `${fault}: transport cause kept, body not quoted`);
    if (fault === 'rst') assert.ok(infrastructureFault(direct), 'a reset reply reaches ECONNRESET through its cause');
    for (const outage of [workerOutage, undefined]) {
      const before = requests.length;
      await assert.rejects(embedBatch(embedder, ['secret input'], bound(), [10, 10], undefined, outage), error =>
        error instanceof EmbedderUnavailableError, `${fault}: embedBatch ends unavailable`);
      if (fault !== 'stall') assert.equal(requests.length - before, 3, `${fault}: embedBatch retried the interruption`);
    }
  }
  // A redirect, even one that keeps the method, is refused: the inputs never reach another origin.
  answer = { status: 307, body: {}, location: `http://127.0.0.1:${elsewhere.address().port}/v1/embeddings` };
  await assert.rejects(embedder.embed(['secret input'], AbortSignal.timeout(5_000)), EmbedderUnavailableError);
  assert.deepEqual(redirected, [], 'the redirect target received nothing');
});
