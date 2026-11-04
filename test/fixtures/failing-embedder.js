// An embedder that always fails, for the retrieval evaluation's bounded-drain test (STA-49). It stands in for a provider
// sandbox that keeps answering 5xx (an outage) or, with FAILING_EMBEDDER_MODE=refuse, 4xx (a refused input). Its error
// carries FAILING_EMBEDDER_SECRET, which the evaluation must never print.
import { DeterministicEmbedder, EmbedderUnavailableError } from '../../packages/retrieval/dist/index.js';

class FailingEmbedder extends DeterministicEmbedder {
  async embed() {
    const detail = `provider answer ${process.env.FAILING_EMBEDDER_SECRET ?? ''}`;
    throw process.env.FAILING_EMBEDDER_MODE === 'refuse' ? new Error(detail) : new EmbedderUnavailableError(detail);
  }
}

export default new FailingEmbedder();
