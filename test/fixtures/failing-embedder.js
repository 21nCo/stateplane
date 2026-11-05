// An embedder that fails, for the retrieval evaluation's tests (STA-49). It stands in for a provider sandbox that keeps
// answering 5xx (an outage) or, with FAILING_EMBEDDER_MODE=refuse, 4xx (a refused input); with FAILING_EMBEDDER_MODE=
// queries it fails only queries listed in FAILING_EMBEDDER_QUERIES (|-separated), as an outage after indexing would.
// FAILING_EMBEDDER_DIMENSIONS sets its dimensions. Its error carries FAILING_EMBEDDER_SECRET, which the evaluation must
// never print.
import { DeterministicEmbedder, EmbedderUnavailableError } from '../../packages/retrieval/dist/index.js';

const failing = new Set((process.env.FAILING_EMBEDDER_QUERIES ?? '').split('|').filter(Boolean));

class FailingEmbedder extends DeterministicEmbedder {
  async embed(texts, signal) {
    const mode = process.env.FAILING_EMBEDDER_MODE;
    if (mode === 'queries' && !texts.some(text => failing.has(text))) return super.embed(texts, signal);
    const detail = `provider answer ${process.env.FAILING_EMBEDDER_SECRET ?? ''}`;
    throw mode === 'refuse' ? new Error(detail) : new EmbedderUnavailableError(detail);
  }
}

export default new FailingEmbedder({ dimensions: Number(process.env.FAILING_EMBEDDER_DIMENSIONS ?? 384) });
