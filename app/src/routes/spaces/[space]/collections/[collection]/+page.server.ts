import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { api, pageCursor, writeClock } from '$lib/server/api';
import { carriedId, selectors } from '$lib/paths';
import { expiredRetry, given, jsonObject, unresolvedAfter, writeAttempt } from '$lib/server/forms';
import { predicates, sortProblem } from '$lib/query';
import type { FilterRow } from '$lib/query';
import type { ApiError } from '$lib/errors';
import type { Collection, Receipt, StoredRecord } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

// The v1 query accepts 1–100 records per page; 25 keeps a page readable.
const defaultLimit=25;
const path=(url:URL)=>{ const {space,collection}=selectors(url); return ['spaces',space,'collections',collection]; };

export const load:PageServerLoad=async(event)=>{
  const params=event.url.searchParams;
  const collection=await api<Collection>(event,'GET',path(event.url));
  // Field names travel carried in the query, as the form and its links send them.
  const rows:FilterRow[]=params.getAll('field').map((field,index)=>({field:carriedId(field),op:params.getAll('op')[index] ?? 'eq',
    value:params.getAll('value')[index] ?? ''})).filter(row=>row.field);
  const requested=Number(params.get('limit') ?? defaultLimit);
  const limit=Number.isInteger(requested) && requested>=1 && requested<=100 ? requested : defaultLimit;
  const sort=params.get('sort') ? {field:carriedId(params.get('sort')!),direction:params.get('dir')==='desc' ? 'desc' : 'asc'} : undefined;
  const {cursor,paged,rejected}=pageCursor(event.url);
  const filterErrors:Record<number,string>={};
  // An exact count reads every matching record, so it runs only when asked for (count=1),
  // never on page navigation, and its failure leaves the page's records in place.
  const counted=params.get('count')==='1';
  const view={rows,limit,sort,cursor:cursor ?? null,paged,counted,limitInvalid:limit!==requested,idempotencyKey:`ui-${randomUUID()}`,
    sortError:null as string|null,count:null as number|null,countError:null as ApiError|null};
  if (!collection.ok) return {...view,collection:null,error:collection.error,filterErrors,page:null};
  // A query the authority would refuse is reported on its fields and never sent.
  const {definition,ready}=collection.data;
  const built=predicates(definition,rows,ready);
  const sortError=sort ? sortProblem(definition,ready,sort.field) : null;
  if (Object.keys(built.errors).length || sortError) return {...view,collection:collection.data,error:null,filterErrors:built.errors,sortError,page:null};
  const [page,count]=rejected ? [rejected,null] : await Promise.all([
    api<{records:StoredRecord[];nextCursor:string|null;schemaVersion:number}>(event,'POST',[...path(event.url),'records','query'],
      {body:{predicates:built.predicates,limit,...(sort ? {sort} : {}),...(cursor!==undefined ? {cursor} : {})}}),
    counted ? api<number>(event,'POST',[...path(event.url),'records','count'],{body:built.predicates}) : null]);
  return {...view,collection:collection.data,error:page.ok ? null : page.error,filterErrors,page:page.ok ? page.data : null,
    count:count?.ok ? count.data : null,countError:count && !count.ok ? count.error : null};
};

export const actions:Actions={
  create:async(event)=>{
    const form=await event.request.formData();
    // The editor's text always stays the draft; a retry resends the unresolved request instead.
    const raw=String(form.get('data')??'');
    const draftKey=String(form.get('externalKey')??'');
    const draft=jsonObject(raw);
    const attempt=writeAttempt(form,draft ? {externalKey:draftKey,data:draft} : null,writeClock(event));
    const values={raw,externalKey:draftKey,invalid:!attempt.request && attempt.forgotten===null,error:null as ApiError|null,retried:attempt.retry};
    // Forgetting a write sends nothing; the draft stays in the editor.
    if (attempt.forgotten!==null) return {draft:{raw,externalKey:draftKey},pending:attempt.rest};
    if (!attempt.request || attempt.full) return fail(400,{create:values,pending:attempt.pending});
    // Past its deadline the key may no longer recover the write, so a retry could create it twice.
    if (attempt.expired) return fail(400,{create:{...values,error:expiredRetry},pending:attempt.pending});
    const {externalKey,data}=attempt.request as {externalKey:string;data:Record<string,unknown>};
    const result=await api<Receipt>(event,'POST',[...path(event.url),'records'],
      {body:{operation:'create',idempotencyKey:attempt.key,data,...(given(externalKey) ? {externalKey} : {})}});
    // A retry sent an earlier request, so the unsent draft stays in the editor.
    if (result.ok) return {created:result.data,pending:unresolvedAfter(attempt,null),
      draft:attempt.retry ? {raw,externalKey:draftKey} : null};
    return fail(result.status,{create:{...values,error:result.error},pending:unresolvedAfter(attempt,result.error)});
  }
};
