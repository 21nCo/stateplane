/** Parse a JSON object field; a malformed value is reported on that field before any API call. */
export function jsonObject(raw:FormDataEntryValue|null):Record<string,unknown>|null {
  try {
    const value:unknown=JSON.parse(String(raw??''));
    return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
  } catch { return null; }
}
