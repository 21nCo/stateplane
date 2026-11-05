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
      // A redirect is refused, never followed: the inputs and credential go to the configured endpoint only.
      response = await fetch(endpoint, { method: 'POST', signal, redirect: 'error',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, input: texts, dimensions }) });
    } catch (error) { throw new EmbedderUnavailableError('Embedding request failed', { cause: error }); }
    // A provider timeout, overload or server fault is an outage; any other refusal is the input's. Neither quotes the body.
    if (response.status === 408 || response.status === 429 || response.status >= 500)
      throw new EmbedderUnavailableError(`Embedding provider answered ${response.status}`);
    if (!response.ok) throw new Error(`Embedding provider refused the request (${response.status})`);
    return vectorsOf((await response.json())?.data, texts.length);
  }
}

/** Exactly one vector per input, placed by its index; any other answer is the provider's malformed reply. */
function vectorsOf(data, count) {
  if (!Array.isArray(data) || data.length !== count) throw new Error('Embedding provider answered with the wrong number of vectors');
  const vectors = new Array(count).fill(null);
  for (const item of data) {
    if (!Number.isSafeInteger(item?.index) || item.index < 0 || item.index >= count || vectors[item.index] !== null)
      throw new Error('Embedding provider answered with a missing, repeated or out-of-range index');
    vectors[item.index] = item.embedding;
  }
  return vectors;
}

export default new HttpEmbedder();
