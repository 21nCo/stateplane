/** Read one bounded JSON value after optional Wrangler status lines. */
export function readWranglerJson(output) {
  if (output.length > 1024 * 1024) throw new Error('Wrangler response is too large');
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== '{' && output[index] !== '[') continue;
    try { return JSON.parse(output.slice(index)); }
    catch { /* A status line may contain brackets; try the next JSON start. */ }
  }
  throw new Error('Wrangler returned no valid JSON');
}
