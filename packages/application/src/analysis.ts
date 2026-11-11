import { TransportFailure } from './errors.js';

/**
 * A spec that may be passed on for admission: a JSON object holding only
 * finite numbers. A literal such as `1e400` parses as Infinity, which JSON
 * re-encodes as null, a different spec from the one sent; it is refused, not
 * changed. Iterative, so a deeply nested spec cannot exhaust the stack.
 */
function admissibleSpec(spec: unknown): boolean {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false;
  const pending: unknown[] = [spec];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'number' && !Number.isFinite(item)) return false;
    if (item && typeof item === 'object') for (const value of Object.values(item)) pending.push(value);
  }
  return true;
}

/**
 * An aggregation spec's JSON text, as HTTP and MCP both hand it to
 * `analysis.aggregate` once it is within its byte budget. Parseable text that
 * is not an object, or holds a number JSON cannot state, is refused
 * `INVALID_ARGUMENT` before admission, as the CLI refuses it before sending;
 * it inspects no stored state. Unparseable text is the service's to refuse,
 * after admission.
 */
export function analysisAggregation(text: string): string {
  let spec: unknown;
  try { spec = JSON.parse(text); } catch { return text; }
  if (!admissibleSpec(spec)) throw new TransportFailure('INVALID_ARGUMENT');
  return text;
}

/**
 * The submission an analysis job request `{ kind, spec? }` names, as HTTP and
 * MCP both hand it to `analysis.submit`: the kind, and the spec (an aggregate
 * job's) re-encoded as JSON text, which the service checks against the
 * collection only after it has admitted the caller. Before admission, in this
 * order, and inspecting no stored state: a request that is not an object of
 * those two members, or names another kind, is refused `INVALID_ARGUMENT`; a
 * re-encoded spec over `specBytes` (the service's spec bound, an aggregation
 * body's budget) is refused `RATE_LIMITED`, not retryable, as a larger
 * aggregation body is; then a spec that is not an object, or holds a number
 * JSON cannot state, is refused `INVALID_ARGUMENT`. The CLI applies the same
 * order before it sends, so every caller meets one code on every transport.
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
  if (!admissibleSpec(body.spec)) refuse();
  return { kind, spec };
}
