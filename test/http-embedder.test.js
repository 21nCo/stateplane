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
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
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
});
