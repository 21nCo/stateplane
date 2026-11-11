import { admitAggregation, admitAnalysisJob, type AnalysisRefusal } from '@stateplane/contracts';
import { TransportFailure } from './errors.js';

/** A size is refused not retryable (the same request cannot fit later); anything else is invalid. */
const refuse = (code: AnalysisRefusal): never => {
  throw new TransportFailure(code, code === 'RATE_LIMITED' ? false : undefined);
};

/**
 * The aggregation spec HTTP (its parsed body, null when it does not parse) and
 * MCP (its arguments) hand to `analysis.aggregate`: the compact text
 * `admitAggregation` measures, after the checks it makes before admission in
 * the order the CLI makes them before sending. It inspects no stored state.
 */
export function analysisAggregation(spec: unknown): string {
  const admitted = admitAggregation(spec);
  return 'refused' in admitted ? refuse(admitted.refused) : admitted.spec;
}

/**
 * The submission an analysis job request `{ kind, spec? }` names, as HTTP and
 * MCP hand it to `analysis.submit`: the kind and the spec's compact text, after
 * the checks `admitAnalysisJob` makes before admission in the order the CLI
 * makes them before sending. The service checks the spec against the
 * collection only after it has admitted the caller.
 */
export function analysisSubmission(request: unknown): { kind: 'aggregate' | 'export'; spec: string | undefined } {
  const admitted = admitAnalysisJob(request);
  return 'refused' in admitted ? refuse(admitted.refused) : admitted;
}
