import { TransportFailure } from './errors.js';

/**
 * The submission an analysis job request `{ kind, spec? }` names, as HTTP and
 * MCP both hand it to `analysis.submit`: the kind, and the spec (an aggregate
 * job's) re-encoded as JSON text, which the service parses and checks only
 * after it has admitted the caller. A request that is not an object of those
 * two members, or names another kind, is refused before admission, as the
 * service refuses an unknown kind; it inspects no stored state. A re-encoded
 * spec over `specBytes` (the service's spec bound, an aggregation body's
 * budget) is refused `RATE_LIMITED`, not retryable, after authentication, as a
 * larger aggregation body is, so every caller meets one code on every transport.
 */
export function analysisSubmission(request: unknown, specBytes: number): { kind: 'aggregate' | 'export'; spec: string | undefined } {
  const refuse = (): never => { throw new TransportFailure('INVALID_ARGUMENT'); };
  if (!request || typeof request !== 'object' || Array.isArray(request)) return refuse();
  const body = request as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== 'kind' && key !== 'spec')) refuse();
  const kind = Object.hasOwn(body, 'kind') ? body.kind : undefined;
  if (kind !== 'aggregate' && kind !== 'export') return refuse();
  if (!Object.hasOwn(body, 'spec')) return { kind, spec: undefined };
  let spec: string | undefined;
  try { spec = JSON.stringify(body.spec); } catch { return refuse(); }
  if (spec === undefined) return refuse();
  if (new TextEncoder().encode(spec).byteLength > specBytes) throw new TransportFailure('RATE_LIMITED', false);
  return { kind, spec };
}
