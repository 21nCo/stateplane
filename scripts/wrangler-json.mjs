/** Move past a quoted JSON string without interpreting brackets inside it. */
function afterString(output, start) {
  let cursor = start + 1;
  while (cursor < output.length) {
    if (output[cursor] === '\\') cursor += 2;
    else if (output[cursor] === '"') return cursor + 1;
    else cursor++;
  }
  return output.length;
}

/** Scan one non-overlapping candidate, including malformed status text. */
function scanCandidate(output, start) {
  const stack = [];
  let cursor = start;
  while (cursor < output.length) {
    const char = output[cursor];
    if (char === '"') {
      cursor = afterString(output, cursor);
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return { end: cursor, balanced: false };
      if (stack.length === 0) return { end: cursor, balanced: true };
    }
    cursor++;
  }
  return { end: output.length - 1, balanced: false };
}

function nextOpening(output, cursor) {
  const object = output.indexOf('{', cursor);
  const array = output.indexOf('[', cursor);
  if (object === -1) return array;
  if (array === -1) return object;
  return Math.min(object, array);
}

/** Read one bounded JSON value after optional Wrangler status lines. */
export function readWranglerJson(output) {
  if (output.length > 1024 * 1024) throw new Error('Wrangler response is too large');
  let cursor = 0;
  while (cursor < output.length) {
    const start = nextOpening(output, cursor);
    if (start === -1) break;
    const { end, balanced } = scanCandidate(output, start);
    cursor = end + 1;
    if (!balanced) continue;
    try { return JSON.parse(output.slice(start, cursor)); }
    catch { /* A balanced status line can precede Wrangler's JSON value. */ }
  }
  throw new Error('Wrangler returned no valid JSON');
}
