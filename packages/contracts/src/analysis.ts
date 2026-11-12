/**
 * The checks an analysis request passes before admission, shared by HTTP, MCP
 * and the CLI (which bundles this package), so every transport decides them
 * from one representation in one order.
 *
 * - `bodyBytes`: the text as sent that HTTP reads and the CLI accepts, eight
 *   times `specBytes`: room for a request of `requestBytes` with every
 *   character `\u`-escaped (six bytes each), so within it whitespace, escapes
 *   and a number's spelling never decide a refusal, the compact form does. It
 *   leaves MCP (whose arguments arrive parsed) over 3.7 MiB of its 4 MiB
 *   JSON-RPC bound for framing, so the same text decides alike there.
 * - `specBytes`: an aggregation spec, alone or as a job's `spec` (the
 *   service's `aggregationBounds.specBytes`, the records query budget).
 * - `requestBytes`: a job request, that spec in its `{"kind","spec"}` envelope.
 * - `specDepth`: nested objects and arrays in a spec, the spec itself counting
 *   one. The deepest spec the grammar admits has 4 (the spec, `where`, a
 *   predicate, an `in` predicate's values); 16 leaves room for the grammar to
 *   grow while every recursive JSON encoder or decoder behind admission stays
 *   far inside its stack (a 10,000-level spec overflowed them at STA-61 review).
 */
export const analysisBounds = Object.freeze({ bodyBytes: 262_144, specBytes: 32_768, requestBytes: 33_792, specDepth: 16 });

/** A refusal before admission: a size (not retryable) or an invalid request. */
export type AnalysisRefusal = 'RATE_LIMITED' | 'INVALID_ARGUMENT';
export type AdmittedAggregation = { spec: string } | { refused: AnalysisRefusal };
export type AdmittedAnalysisJob = { kind: 'aggregate' | 'export'; spec: string | undefined } | { refused: AnalysisRefusal };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

interface Encoded { text: string; depth: number; finite: boolean }
interface Frame { node: object; keys: string[] | null; index: number }

/** UTF-8 bytes of JSON text (a lone surrogate, which JSON escapes, would be 3, as TextEncoder writes it). */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

/**
 * A parsed JSON value's compact text as written, iteratively, so no nesting
 * exhausts the stack: a number JSON cannot state keeps a literal (`1e400`,
 * `-1e400`) rather than `JSON.stringify`'s `null`, and `-0` stays `-0`, as
 * MCP's `serializeJson` writes them. Every transport measures this text, so a
 * spec has one size whether it arrived as an HTTP body, MCP arguments or CLI
 * input. Writing stops at the first byte past `limit` (`'over'`), so the text,
 * the open containers (each wrote a byte) and the objects tracked are all
 * bounded by it, whatever the input. Undefined for a value JSON cannot hold.
 */
function encode(value: unknown, limit: number): Encoded | 'over' | undefined {
  const parts: string[] = [];
  const stack: Frame[] = [];
  const active = new Set<object>();
  let bytes = 0, depth = 0, finite = true;
  // False once past the limit. A string is at least as many bytes as it has code units, so a longer one is not encoded.
  const write = (text: string): boolean => { parts.push(text); bytes += utf8Bytes(text); return bytes <= limit; };
  const string = (text: string): boolean => text.length <= limit - bytes && write(JSON.stringify(text));
  type Step = 'ok' | 'over' | 'invalid';
  const emit = (item: unknown): Step => {
    let written: boolean;
    if (item === null) written = write('null');
    else if (typeof item === 'string') written = string(item);
    else if (typeof item === 'boolean') written = write(item ? 'true' : 'false');
    else if (typeof item === 'number') {
      if (Number.isNaN(item)) return 'invalid';
      if (!Number.isFinite(item)) finite = false;
      written = write(item === Infinity ? '1e400' : item === -Infinity ? '-1e400' : Object.is(item, -0) ? '-0' : JSON.stringify(item));
    } else if (item && typeof item === 'object') {
      if (active.has(item)) return 'invalid';
      active.add(item);
      const keys = Array.isArray(item) ? null : Object.keys(item);
      stack.push({ node: item, keys, index: 0 });
      if (stack.length > depth) depth = stack.length;
      written = write(keys ? '{' : '[');
    } else return 'invalid';
    return written ? 'ok' : 'over';
  };
  let step = emit(value);
  while (step === 'ok' && stack.length) {
    const frame = stack[stack.length - 1]!;
    const length = frame.keys ? frame.keys.length : (frame.node as unknown[]).length;
    if (frame.index === length) {
      active.delete(frame.node);
      stack.pop();
      if (!write(frame.keys ? '}' : ']')) step = 'over';
      continue;
    }
    if (frame.index && !write(',')) { step = 'over'; continue; }
    const at = frame.index++;
    let item: unknown;
    if (frame.keys) {
      const key = frame.keys[at]!;
      if (!string(key) || !write(':')) { step = 'over'; continue; }
      item = (frame.node as Record<string, unknown>)[key];
    } else item = (frame.node as unknown[])[at];
    step = emit(item);
  }
  if (step !== 'ok') return step === 'over' ? 'over' : undefined;
  return { text: parts.join(''), depth, finite };
}

/**
 * Admit a parsed aggregation spec, or refuse it before admission, in this
 * order: its compact text over `specBytes` is `RATE_LIMITED`; nested past
 * `specDepth`, `INVALID_ARGUMENT`; not an object, or holding a number that
 * overflows, `INVALID_ARGUMENT`. Text that does not parse reaches this as
 * null (refused as not an object). Returns the compact text to hand on.
 */
export function admitAggregation(spec: unknown): AdmittedAggregation {
  const encoded = encode(spec, analysisBounds.specBytes);
  if (!encoded) return { refused: 'INVALID_ARGUMENT' };
  if (encoded === 'over') return { refused: 'RATE_LIMITED' };
  if (encoded.depth > analysisBounds.specDepth || !object(spec) || !encoded.finite) return { refused: 'INVALID_ARGUMENT' };
  return { spec: encoded.text };
}

/**
 * Admit a parsed job request `{ kind, spec? }`, or refuse it before admission,
 * in this order: its compact text over `requestBytes` is `RATE_LIMITED`; not
 * an object of those two members, or another kind, `INVALID_ARGUMENT`; then its
 * spec as `admitAggregation` checks one: over `specBytes`, `RATE_LIMITED`;
 * nested past `specDepth`, not an object, or holding a number that overflows,
 * `INVALID_ARGUMENT`. So a spec gets one code as an aggregation and in a job.
 * Returns the kind and the spec's compact text.
 */
export function admitAnalysisJob(request: unknown): AdmittedAnalysisJob {
  const encoded = encode(request, analysisBounds.requestBytes);
  if (!encoded) return { refused: 'INVALID_ARGUMENT' };
  if (encoded === 'over') return { refused: 'RATE_LIMITED' };
  if (!object(request) || Object.keys(request).some(key => key !== 'kind' && key !== 'spec')) return { refused: 'INVALID_ARGUMENT' };
  const kind = Object.hasOwn(request, 'kind') ? request.kind : undefined;
  if (kind !== 'aggregate' && kind !== 'export') return { refused: 'INVALID_ARGUMENT' };
  if (!Object.hasOwn(request, 'spec')) return { kind, spec: undefined };
  // A member of a request that encoded within its limit encodes too.
  const spec = encode(request.spec, analysisBounds.specBytes) as Encoded | 'over';
  if (spec === 'over') return { refused: 'RATE_LIMITED' };
  if (spec.depth > analysisBounds.specDepth || !object(request.spec) || !spec.finite) return { refused: 'INVALID_ARGUMENT' };
  return { kind, spec: spec.text };
}
