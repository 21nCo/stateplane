/** Re-encode a JSON-RPC argument for the serialized authority boundary.
 *
 * MCP arguments arrive already parsed. `JSON.stringify` would turn an
 * out-of-range literal such as `1e400` (parsed as Infinity) into `null` and
 * `-0` into `0`, so a request that HTTP rejects could be admitted as a
 * different value. This encoder emits a literal that the authority's
 * `JSON.parse` maps back to the same number, so both transports reach the
 * same validation and request fingerprint. Strings use JSON's escaping, which
 * keeps an unpaired surrogate visible to Unicode validation. */
export function serializeJson(value: unknown): string {
  const parts: string[] = [];
  write(value, parts, new Set());
  return parts.join('');
}

function write(value: unknown, parts: string[], active: Set<object>): void {
  if (value === null) { parts.push('null'); return; }
  switch (typeof value) {
    case 'string': parts.push(JSON.stringify(value)); return;
    case 'boolean': parts.push(value ? 'true' : 'false'); return;
    case 'number':
      if (Number.isNaN(value)) throw new TypeError('NaN is not a JSON value');
      if (value === Infinity) parts.push('1e400');
      else if (value === -Infinity) parts.push('-1e400');
      else if (Object.is(value, -0)) parts.push('-0');
      else parts.push(JSON.stringify(value));
      return;
    case 'object': break;
    default: throw new TypeError('Value is not JSON');
  }
  const object = value as object;
  if (active.has(object)) throw new TypeError('Cyclic value is not JSON');
  active.add(object);
  if (Array.isArray(object)) {
    parts.push('[');
    for (let index = 0; index < object.length; index++) {
      if (index) parts.push(',');
      write(object[index], parts, active);
    }
    parts.push(']');
  } else {
    parts.push('{');
    let first = true;
    for (const key of Object.keys(object)) {
      if (!first) parts.push(',');
      first = false;
      parts.push(JSON.stringify(key), ':');
      write((object as Record<string, unknown>)[key], parts, active);
    }
    parts.push('}');
  }
  active.delete(object);
}
