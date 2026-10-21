import { createHmac } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { definitive, maxUnresolved, uncertain } from '../errors';
import type { ApiError } from '$lib/errors';
import { sessionCookie, writeClock as hostClock } from './api';
import { retryDeadline, seal } from './receipts';
import type { Sealed } from './receipts';

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
 * exact request, with the signed server time of its first send, which the form
 * posts back as repeated pendingKey, pendingSent, pendingAt and pendingSeal.
 * Each one stays until a receipt or a definitive result for it, or until the owner
 * forgets it; a later write never replaces it. Every submission posts the whole
 * list back, so at most three are kept and a new request is refused past that.
 * Its key recovers it only until its receipt can expire, so past its deadline, or
 * with an altered stamp, it is expired: still shown, never retried. A receipt belongs to
 * the credential that sent its request (contracts/v1.md), so each write is sealed for the
 * session's credential and carries "by", a digest of it, never the bearer: under another
 * credential it is foreign, never retried, and recoverable again once that one returns. */
export interface Unresolved extends Sealed { by:string; deadline:string|null; expired:boolean; foreign:boolean }
export interface WriteClock { secret:Buffer|null; now:number; by:string }
export const writeClock=(event:{platform?:App.Platform|undefined;cookies:Cookies}):WriteClock=>{
  const {secret,now}=hostClock(event), mac=(use:string)=>secret && createHmac('sha256',secret).update(`${use}\0${event.cookies.get(sessionCookie)??''}`).digest();
  return {secret:mac('seal'),now,by:mac('by')?.toString('base64url') ?? ''};
};
const shown=(clock:WriteClock,write:Sealed&{by:string}):Unresolved=>{
  const deadline=retryDeadline(clock.secret,write);
  return {...write,deadline:deadline===null ? null : new Date(deadline).toISOString(),expired:deadline===null || clock.now>deadline,foreign:write.by!==clock.by};
};
export const unresolved=(form:FormData,clock:WriteClock):Unresolved[]=>{
  const [keys,sent,at,seals,by]=['pendingKey','pendingSent','pendingAt','pendingSeal','pendingBy'].map(name=>form.getAll(name));
  const text=(value:FormDataEntryValue|undefined)=>typeof value==='string' ? value : '';
  return keys.flatMap((key,index)=>typeof key==='string' && typeof sent[index]==='string' && jsonObject(sent[index]) ?
    [shown(clock,{key,sent:sent[index] as string,at:text(at[index]),seal:text(seals[index]),by:text(by[index])})] : []).slice(0,maxUnresolved);
};
/** A retry that is not sent, because its key may no longer recover its request. */
export const expiredRetry:ApiError={code:'RECEIPT_EXPIRED',retryable:false,requestId:null};
export const foreignRetry:ApiError={...expiredRetry,code:'OTHER_CREDENTIAL'};

/** One write submission. "Retry unchanged" names one unresolved write and resends
 * its request under its key, unless it expired or is foreign; "Forget" names one to stop
 * tracking and sends nothing. Any other submission is the draft, a new request
 * under the key made when the page loaded. A malformed draft (request null) is
 * never sent, and while the list is full (full) no new request is sent. */
export function writeAttempt(form:FormData,draft:Record<string,unknown>|null,clock:WriteClock) {
  const pending=unresolved(form,clock);
  const chosen=(name:string)=>{ const value=form.get(name); return typeof value==='string' && /^\d$/.test(value) && pending[Number(value)] ? Number(value) : null; };
  const retried=chosen('retry'), forgotten=chosen('forget');
  const retry=retried!==null;
  const request=retry ? jsonObject(pending[retried].sent) : forgotten===null ? draft : null;
  return {pending,retried,forgotten,retry,request,clock,refused:!retry || !pending[retried].expired ? null : pending[retried].foreign ? foreignRetry : expiredRetry,
    full:!retry && forgotten===null && pending.length>=maxUnresolved,
    rest:pending.filter((_,index)=>index!==(retried ?? forgotten)),
    key:retry ? pending[retried].key : String(form.get('idempotencyKey')??'')};
}
type Attempt=ReturnType<typeof writeAttempt>;

/** The unresolved writes after an attempt (error null for a receipt). A receipt or a
 * definitive result ends the retried write; any other refusal can come before its
 * key is looked up, so it stays. An uncertain new request joins the list, stamped
 * with the time the submission arrived, before it was sent. */
export const unresolvedAfter=(attempt:Attempt,error:ApiError|null):Unresolved[]=>
  attempt.retry ? (!error || definitive(error) ? attempt.rest : attempt.pending) :
  error && uncertain(error) ? [...attempt.pending,shown(attempt.clock,{...seal(attempt.clock.secret,attempt.key,JSON.stringify(attempt.request),attempt.clock.now),by:attempt.clock.by})] :
  attempt.pending;
