import { definitive, maxUnresolved, uncertain } from '../errors';
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
 * exact request, which the form posts back as repeated pendingKey and pendingSent.
 * Each one stays until a receipt or a definitive result for it, or until the owner
 * forgets it; a later write never replaces it. Every submission posts the whole
 * list back, so at most three are kept and a new request is refused past that. */
export interface Unresolved { key:string; sent:string }
export const unresolved=(form:FormData):Unresolved[]=>{
  const keys=form.getAll('pendingKey'), sent=form.getAll('pendingSent');
  return keys.flatMap((key,index)=>typeof key==='string' && typeof sent[index]==='string' && jsonObject(sent[index]) ?
    [{key,sent:sent[index] as string}] : []).slice(0,maxUnresolved);
};

/** One write submission. "Retry unchanged" names one unresolved write and resends
 * its request under its key; "Forget" names one to stop tracking and sends nothing.
 * Any other submission is the draft, a new request under the key made when the page
 * loaded. A malformed draft (request null) is never sent, and while the list is full
 * (full) no new request is sent. */
export function writeAttempt(form:FormData,draft:Record<string,unknown>|null) {
  const pending=unresolved(form);
  const chosen=(name:string)=>{ const value=form.get(name); return typeof value==='string' && /^\d$/.test(value) && pending[Number(value)] ? Number(value) : null; };
  const retried=chosen('retry'), forgotten=chosen('forget');
  const retry=retried!==null;
  const request=retry ? jsonObject(pending[retried].sent) : forgotten===null ? draft : null;
  return {pending,retried,forgotten,retry,request,full:!retry && forgotten===null && pending.length>=maxUnresolved,
    rest:pending.filter((_,index)=>index!==(retried ?? forgotten)),
    key:retry ? pending[retried].key : String(form.get('idempotencyKey')??'')};
}
type Attempt=ReturnType<typeof writeAttempt>;

/** The unresolved writes after an attempt (error null for a receipt). A receipt or a
 * definitive result ends the retried write; any other refusal can come before its
 * key is looked up, so it stays. An uncertain new request joins the list. */
export const unresolvedAfter=(attempt:Attempt,error:ApiError|null):Unresolved[]=>
  attempt.retry ? (!error || definitive(error) ? attempt.rest : attempt.pending) :
  error && uncertain(error) ? [...attempt.pending,{key:attempt.key,sent:JSON.stringify(attempt.request)}] : attempt.pending;
