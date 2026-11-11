/**
 * The checks an analysis request passes before admission, shared by HTTP, MCP
 * and the CLI (which bundles this package), so every transport decides them
 * from one representation in one order.
 *
 * - `specBytes`: an aggregation spec, alone or as a job's `spec` (the
 *   service's `aggregationBounds.specBytes`, the records query budget).
 * - `requestBytes`: a job request, that spec in its `{"kind","spec"}` envelope.
 * - `specDepth`: nested objects and arrays in a spec, the spec itself counting
 *   one. The deepest spec the grammar admits has 4 (the spec, `where`, a
 *   predicate, an `in` predicate's values); 16 leaves room for the grammar to
 *   grow while every recursive JSON encoder or decoder behind admission stays
 *   far inside its stack (a 10,000-level spec overflowed them at STA-61 review).
 */
export const analysisBounds = Object.freeze({ specBytes: 32_768, requestBytes: 33_792, specDepth: 16 });

/** A refusal before admission: a size (not retryable) or an invalid request. */
export type AnalysisRefusal = 'RATE_LIMITED' | 'INVALID_ARGUMENT';
export type AdmittedAggregation = { spec: string } | { refused: AnalysisRefusal };
export type AdmittedAnalysisJob = { kind: 'aggregate' | 'export'; spec: string | undefined } | { refused: AnalysisRefusal };

const utf8 = new TextEncoder();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

interface Encoded { text: string; bytes: number; depth: number; finite: boolean }
interface Frame { node: object; keys: string[] | null; index: number }

/**
 * A parsed JSON value's compact text as written, iteratively, so no nesting
 * exhausts the stack: a number JSON cannot state keeps a literal (`1e400`,
 * `-1e400`) rather than `JSON.stringify`'s `null`, and `-0` stays `-0`, as
 * MCP's `serializeJson` writes them. Every transport measures this text, so a
 * spec has one size whether it arrived as an HTTP body, MCP arguments or CLI
 * input. Undefined for a value JSON cannot hold.
 */
function encode(value: unknown): Encoded | undefined {
  const parts: string[] = [];
  const stack: Frame[] = [];
  const active = new Set<object>();
  let depth = 0, finite = true;
  const emit = (item: unknown): boolean => {
    if (item === null) parts.push('null');
    else if (typeof item === 'string') parts.push(JSON.stringify(item));
    else if (typeof item === 'boolean') parts.push(item ? 'true' : 'false');
    else if (typeof item === 'number') {
      if (Number.isNaN(item)) return false;
      if (!Number.isFinite(item)) finite = false;
      parts.push(item === Infinity ? '1e400' : item === -Infinity ? '-1e400' : Object.is(item, -0) ? '-0' : JSON.stringify(item));
    } else if (item && typeof item === 'object') {
      if (active.has(item)) return false;
      active.add(item);
      const keys = Array.isArray(item) ? null : Object.keys(item);
      parts.push(keys ? '{' : '[');
      stack.push({ node: item, keys, index: 0 });
      if (stack.length > depth) depth = stack.length;
    } else return false;
    return true;
  };
  if (!emit(value)) return undefined;
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const length = frame.keys ? frame.keys.length : (frame.node as unknown[]).length;
    if (frame.index === length) {
      parts.push(frame.keys ? '}' : ']');
      active.delete(frame.node);
      stack.pop();
      continue;
    }
    if (frame.index) parts.push(',');
    const at = frame.index++;
    let item: unknown;
    if (frame.keys) {
      const key = frame.keys[at]!;
      parts.push(JSON.stringify(key), ':');
      item = (frame.node as Record<string, unknown>)[key];
    } else item = (frame.node as unknown[])[at];
    if (!emit(item)) return undefined;
  }
  const text = parts.join('');
  return { text, bytes: utf8.encode(text).byteLength, depth, finite };
}

/**
 * Admit a parsed aggregation spec, or refuse it before admission, in this
 * order: its compact text over `specBytes` is `RATE_LIMITED`; nested past
 * `specDepth`, `INVALID_ARGUMENT`; not an object, or holding a number that
 * overflows, `INVALID_ARGUMENT`. Text that does not parse reaches this as
 * null (refused as not an object). Returns the compact text to hand on.
 */
export function admitAggregation(spec: unknown): AdmittedAggregation {
  const encoded = encode(spec);
  if (!encoded) return { refused: 'INVALID_ARGUMENT' };
  if (encoded.bytes > analysisBounds.specBytes) return { refused: 'RATE_LIMITED' };
  if (encoded.depth > analysisBounds.specDepth || !object(spec) || !encoded.finite) return { refused: 'INVALID_ARGUMENT' };
  return { spec: encoded.text };
}

/**
 * Admit a parsed job request `{ kind, spec? }`, or refuse it before admission,
 * in this order: its compact text over `requestBytes` is `RATE_LIMITED`;
 * nested past `specDepth` (plus the envelope), not an object of those two
 * members, or another kind, `INVALID_ARGUMENT`; its spec's compact text over
 * `specBytes`, `RATE_LIMITED`; a spec that is not an object, or holds a number
 * that overflows, `INVALID_ARGUMENT`. Returns the kind and the spec's compact
 * text.
 */
export function admitAnalysisJob(request: unknown): AdmittedAnalysisJob {
  const encoded = encode(request);
  if (!encoded) return { refused: 'INVALID_ARGUMENT' };
  if (encoded.bytes > analysisBounds.requestBytes) return { refused: 'RATE_LIMITED' };
  if (encoded.depth > analysisBounds.specDepth + 1 || !object(request) ||
    Object.keys(request).some(key => key !== 'kind' && key !== 'spec')) return { refused: 'INVALID_ARGUMENT' };
  const kind = Object.hasOwn(request, 'kind') ? request.kind : undefined;
  if (kind !== 'aggregate' && kind !== 'export') return { refused: 'INVALID_ARGUMENT' };
  if (!Object.hasOwn(request, 'spec')) return { kind, spec: undefined };
  const spec = encode(request.spec)!;
  if (spec.bytes > analysisBounds.specBytes) return { refused: 'RATE_LIMITED' };
  if (!object(request.spec) || !spec.finite) return { refused: 'INVALID_ARGUMENT' };
  return { kind, spec: spec.text };
}
