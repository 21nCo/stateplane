import { uncertain } from '../errors';
import type { ApiError } from '$lib/errors';

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

/** A write whose outcome is unknown stays explicit page state, separate from the
 * draft and from the latest result: its key and "sent", the canonical JSON of its
 * exact request, which the form posts back as pendingKey and pendingSent. */
export interface Unresolved { key:string; sent:string }
export const unresolved=(form:FormData):Unresolved|null=>{
  const key=form.get('pendingKey'), sent=form.get('pendingSent');
  return typeof key==='string' && typeof sent==='string' && jsonObject(sent) ? {key,sent} : null;
};

/** One write submission. "Retry unchanged" resends the unresolved request under
 * its key; any other submission is the draft, a new request under the key made
 * when the page loaded. A malformed draft (request null) is never sent and leaves
 * the unresolved write as it was. */
export function writeAttempt(form:FormData,draft:Record<string,unknown>|null) {
  const pending=unresolved(form);
  const retry=form.get('intent')==='retry' && pending!==null;
  const request=retry ? jsonObject(pending.sent) : draft;
  return {pending,retry,request,key:retry ? pending.key : String(form.get('idempotencyKey')??'')};
}
type Attempt=ReturnType<typeof writeAttempt>;

/** The unresolved write after a failed attempt. An uncertain result leaves this
 * attempt unresolved; for a new request the owner chose to send instead, beside
 * the stated consequence. A definitive result for the retried request resolves
 * it. A new request the API refused wrote nothing, so the earlier one stays
 * unresolved; only a receipt for a new request ends it, and the page says so. */
export const unresolvedAfter=(attempt:Attempt,error:ApiError):Unresolved|null=>
  uncertain(error) ? {key:attempt.key,sent:JSON.stringify(attempt.request)} : attempt.retry ? null : attempt.pending;
