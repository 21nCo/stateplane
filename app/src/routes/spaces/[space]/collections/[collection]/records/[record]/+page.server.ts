import { randomUUID } from 'node:crypto';
import { fail, redirect } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import { jsonObject, unresolved, unresolvedAfter, writeAttempt, writeClock } from '$lib/server/forms';
import { collectionHref, selectors } from '$lib/paths';
import type { Receipt, StoredRecord } from '$lib/types';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

const recordPath=(url:URL)=>{
  const {space,collection,record}=selectors(url);
  return ['spaces',space,'collections',collection,'records',record];
};
const pretty=(record:StoredRecord)=>JSON.stringify(JSON.parse(record.canonicalData),null,2);

export const load:PageServerLoad=async(event)=>{
  const [record,projection]=await Promise.all([api<StoredRecord>(event,'GET',recordPath(event.url)),
    api<{state:string;generation:number;revision:number}>(event,'GET',[...recordPath(event.url),'projection'])]);
  return {record:record.ok ? {...record.data,pretty:pretty(record.data)} : null,error:record.ok ? null : record.error,
    projection:projection.ok ? projection.data : null,idempotencyKey:`ui-${randomUUID()}`};
};

/** Never resolve a stale write silently: return the current record beside the user's draft.
 * A write to a record loaded on this page that is now NOT_FOUND is gone: deleted concurrently,
 * or for a delete possibly by its own earlier attempt whose receipt has expired.
 * Only a NOT_FOUND reread proves deletion; any other reread failure offers no apply. */
async function conflict(event:RequestEvent,values:Record<string,unknown>) {
  const current=await api<StoredRecord>(event,'GET',recordPath(event.url));
  return fail(409,{...values,conflict:{revision:current.ok ? current.data.revision : null,
    pretty:current.ok ? pretty(current.data) : null,deleted:!current.ok && current.error.code==='NOT_FOUND',
    rereadError:current.ok || current.error.code==='NOT_FOUND' ? null : current.error}});
}
// A key mismatch means the retained request was applied under another body: compare too.
const stale=(code:string)=>['REVISION_CONFLICT','NOT_FOUND','IDEMPOTENCY_MISMATCH'].includes(code);

export const actions:Actions={
  save:async(event)=>{
    const form=await event.request.formData();
    // The editor's text and revision always stay the draft; a retry resends an unresolved request instead.
    const raw=String(form.get('data')??'');
    const draft=jsonObject(raw);
    const expectedRevision=Number(form.get('expectedRevision'));
    const attempt=writeAttempt(form,draft ? {expectedRevision,data:draft} : null,writeClock(event));
    if (attempt.forgotten!==null) return {raw,expectedRevision,pending:attempt.rest};
    if (!attempt.request || attempt.full) return fail(400,{raw,expectedRevision,pending:attempt.pending,invalid:!attempt.request});
    if (attempt.refused) return fail(400,{raw,expectedRevision,pending:attempt.pending,error:attempt.refused,retried:true});
    const request=attempt.request as {expectedRevision:number;data:Record<string,unknown>};
    const result=await api<Receipt>(event,'POST',recordPath(event.url).slice(0,5),
      {body:{operation:'replace',id:selectors(event.url).record,expectedRevision:request.expectedRevision,idempotencyKey:attempt.key,data:request.data}});
    // Every outcome returns the editor's text, so the editor and the unresolved saves it
    // carries render without the record's reread. A recovered save keeps the unsent text;
    // it now targets the recovered revision unless it already targeted a later one.
    if (result.ok) return {saved:result.data,pending:unresolvedAfter(attempt,null),raw,
      expectedRevision:attempt.retry ? Math.max(expectedRevision,result.data.revision) : result.data.revision};
    const values={raw,expectedRevision,pending:unresolvedAfter(attempt,result.error)};
    // Only the draft's own stale write opens the comparison; a refused retry says what happened to it.
    if (!attempt.retry && stale(result.error.code)) return conflict(event,values);
    return fail(result.status,{...values,error:result.error,retried:attempt.retry});
  },
  delete:async(event)=>{
    const form=await event.request.formData();
    const idempotencyKey=String(form.get('idempotencyKey')??'');
    const expectedRevision=Number(form.get('expectedRevision'));
    // A failed delete leaves the unresolved saves on the page. A successful one ends
    // them: each committed before the deletion or can no longer apply after it.
    const pending=unresolved(form,writeClock(event));
    const {space,collection,record}=selectors(event.url);
    const result=await api<Receipt>(event,'POST',recordPath(event.url).slice(0,5),
      {body:{operation:'delete',id:record,expectedRevision,idempotencyKey}});
    if (result.ok) redirect(303,collectionHref(space,collection));
    if (stale(result.error.code)) return conflict(event,{deleting:true,idempotencyKey,expectedRevision,pending});
    // The same key and revision stay with the form so an uncertain delete can replay.
    return fail(result.status,{deleting:true,idempotencyKey,expectedRevision,pending,deleteError:result.error});
  },
  // Keeping the current revision drops the draft or deletion, never the unresolved saves.
  keep:async(event)=>({pending:unresolved(await event.request.formData(),writeClock(event))})
};
