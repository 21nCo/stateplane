// An embedder for the retrieval evaluation against a provider sandbox (STA-49): any endpoint that accepts the
// OpenAI-compatible embeddings request `{ model, input, dimensions? }` and answers `{ data: [{ index, embedding }] }`.
// It is evaluation tooling, not a configured cell embedder. Configure it with:
//   STATEPLANE_EVAL_EMBEDDINGS_URL         the endpoint (https only, except a loopback host)
//   STATEPLANE_EVAL_EMBEDDINGS_MODEL       the model name
//   STATEPLANE_EVAL_EMBEDDINGS_DIMENSIONS  384, 768, 1,024 or 1,536 (the dimensions with an HNSW index), sent as `dimensions`
//   STATEPLANE_EVAL_EMBEDDINGS_KEY         the bearer credential, read from the environment and never printed
//   STATEPLANE_EVAL_EMBEDDINGS_REGION      the processing region label (default `sandbox`)
// and run: node scripts/retrieval-evaluate.mjs --embedder scripts/http-embedder.mjs
import { EmbedderUnavailableError } from '../packages/retrieval/dist/index.js';

const env = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const endpoint = new URL(env('STATEPLANE_EVAL_EMBEDDINGS_URL'));
if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
  throw new Error('STATEPLANE_EVAL_EMBEDDINGS_URL must use https');
const dimensions = Number(env('STATEPLANE_EVAL_EMBEDDINGS_DIMENSIONS'));
if (![384, 768, 1024, 1536].includes(dimensions)) throw new Error('STATEPLANE_EVAL_EMBEDDINGS_DIMENSIONS must be 384, 768, 1024 or 1536');
const model = env('STATEPLANE_EVAL_EMBEDDINGS_MODEL');
const key = env('STATEPLANE_EVAL_EMBEDDINGS_KEY');

class HttpEmbedder {
  profile = Object.freeze({ embedder: 'eval-http', model, modelVersion: model, dimensions,
    region: process.env.STATEPLANE_EVAL_EMBEDDINGS_REGION ?? 'sandbox', quality: 0, costPerMillionCodePoints: 0,
    maxBatch: 64, maxInputCodePoints: 1_000 });

  async embed(texts, signal) {
    let response;
    try {
      response = await fetch(endpoint, { method: 'POST', signal, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts, dimensions }) });
    } catch (error) { throw new EmbedderUnavailableError('Embedding request failed', { cause: error }); }
    // Overload and server faults are outages; any other refusal is the input's. Neither quotes the provider's body.
    if (response.status === 429 || response.status >= 500) throw new EmbedderUnavailableError(`Embedding provider answered ${response.status}`);
    if (!response.ok) throw new Error(`Embedding provider refused the request (${response.status})`);
    const body = await response.json();
    const vectors = new Array(texts.length).fill(null);
    for (const item of body?.data ?? []) if (Number.isSafeInteger(item?.index) && item.index >= 0 && item.index < texts.length) vectors[item.index] = item.embedding;
    // A dense answer: a missing vector is the provider's malformed reply, never a hole for a caller to skip.
    if (vectors.some(vector => vector === null)) throw new Error('Embedding provider answered without a vector for every input');
    return vectors;
  }
}

export default new HttpEmbedder();
