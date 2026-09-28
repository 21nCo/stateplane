/** Read one bounded JSON value after optional Wrangler status lines. */
export function readWranglerJson(output) {
  if (output.length > 1024 * 1024) throw new Error('Wrangler response is too large');
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== '{' && output[index] !== '[') continue;
    const stack = [];
    let quoted = false;
    let escaped = false;
    let end = index;
    for (; end < output.length; end++) {
      const char = output[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) break;
        if (stack.length === 0) {
          try { return JSON.parse(output.slice(index, end + 1)); }
          catch { break; }
        }
      }
    }
    // Candidate spans never overlap. In particular, a malformed opening
    // bracket cannot make us scan the rest of a large response repeatedly.
    index = end;
  }
  throw new Error('Wrangler returned no valid JSON');
}
