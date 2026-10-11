// JSON.parse reads 1e400 as Infinity, which re-serializes as null. Such a value
// is rejected on its field so the API never receives a different value.
const finite=(value:unknown):boolean=>typeof value==='number' ? Number.isFinite(value) :
  value!==null && typeof value==='object' ? Object.values(value).every(finite) : true;

/** Parse a JSON object field; a malformed value is reported on that field before any API call. */
export function jsonObject(raw:FormDataEntryValue|null):Record<string,unknown>|null {
  try {
    const value:unknown=JSON.parse(String(raw??''));
    return value && typeof value==='object' && !Array.isArray(value) && finite(value) ? value as Record<string,unknown> : null;
  } catch { return null; }
}

/** An identifier field is absent only when empty. Any other value, whitespace
 * included, is sent exactly; the API alone normalizes and validates it. */
export const given=(value:string)=>value!=='';
