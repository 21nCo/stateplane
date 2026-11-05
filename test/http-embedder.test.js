import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { embedBatch, EmbedderFailedError, EmbedderUnavailableError } from '../packages/retrieval/dist/index.js';

// The provider-sandbox embedder of the retrieval evaluation, against a local OpenAI-compatible endpoint.
test('the evaluation HTTP embedder orders vectors by index and keeps provider text out of its errors', async t => {
  let answer = null;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.location ? { location: answer.location } : {}) });
    res.end(JSON.stringify(answer.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
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
  // Exactly one vector per input, by index: duplicates, extras, out-of-range or malformed items are refused, never chosen among.
  for (const data of [[{ index: 0, embedding: unit(0) }, { index: 1, embedding: unit(1) }, { index: 1, embedding: unit(2) }],
    [{ index: 0, embedding: unit(0) }, { index: 0, embedding: unit(2) }], [{ index: 0, embedding: unit(0) }, { index: 2, embedding: unit(1) }],
    [{ index: 0, embedding: unit(0) }, { index: '1', embedding: unit(1) }], [{ index: 0, embedding: unit(0) }, null], { 0: unit(0), 1: unit(1) }]) {
    answer = { status: 200, body: { data } };
    await assert.rejects(embedder.embed(['a', 'b'], AbortSignal.timeout(5_000)), error => !(error instanceof EmbedderUnavailableError),
      JSON.stringify(data).slice(0, 80));
  }
  // A provider timeout (408) is an outage that embedBatch retries, not a refused input.
  answer = { status: 408, body: { error: 'timed out on secret input' } };
  await assert.rejects(embedder.embed(['secret input'], AbortSignal.timeout(5_000)), error =>
    error instanceof EmbedderUnavailableError && !error.message.includes('secret'));
  // A redirect, even one that keeps the method, is refused: the inputs never reach another origin.
  answer = { status: 307, body: {}, location: `http://127.0.0.1:${elsewhere.address().port}/v1/embeddings` };
  await assert.rejects(embedder.embed(['secret input'], AbortSignal.timeout(5_000)), EmbedderUnavailableError);
  assert.deepEqual(redirected, [], 'the redirect target received nothing');
});
