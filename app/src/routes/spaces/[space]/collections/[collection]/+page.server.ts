import { randomUUID } from 'node:crypto';
import { fail, redirect } from '@sveltejs/kit';
import { api, pageCursor } from '$lib/server/api';
import { carriedId, carry, selectors } from '$lib/paths';
import { given, jsonObject, unresolvedAfter, writeAttempt, writeClock } from '$lib/server/forms';
import { maxPredicates, predicates, queryBody, searchProblem, sortProblem } from '$lib/query';
import type { FilterRow } from '$lib/query';
import type { ApiError } from '$lib/errors';
import type { Collection, Receipt, StoredRecord } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

// The v1 query accepts 1–100 records per page; 25 keeps a page readable.
const defaultLimit=25;
const path=(url:URL)=>{ const {space,collection}=selectors(url); return ['spaces',space,'collections',collection]; };

// Field names travel carried in the query, as the form and its links send them.
const filterState=(params:URLSearchParams)=>{
  // Each list is read once; past the maxPredicates rows the form sends, the list is refused before any row is built.
  const [fields,ops,values]=['field','op','value'].map(name=>params.getAll(name)), many=fields.length>maxPredicates, rows:FilterRow[]=fields.slice(0,maxPredicates).map((field,index)=>({field:carriedId(field),op:ops[index] ?? 'eq',value:values[index] ?? ''})).filter(row=>row.field);
  const requested=Number(params.get('limit') ?? defaultLimit);
  const limit=Number.isInteger(requested) && requested>=1 && requested<=100 ? requested : defaultLimit;
  const sort=params.get('sort') ? {field:carriedId(params.get('sort')!),direction:params.get('dir')==='desc' ? 'desc' : 'asc'} : undefined;
  const query=new URLSearchParams([...rows.flatMap(row=>[['field',carry(row.field)],['op',row.op],['value',row.value]]),...(sort ? [['sort',carry(sort.field)],['dir',sort.direction]] : []),['limit',String(limit)]]).toString();
  return {rows,requested,limit,sort,query,error:many ? `At most ${maxPredicates} filters apply. Remove filters.` : searchProblem(query)};
};

export const load:PageServerLoad=async(event)=>{
  const params=event.url.searchParams;
  const collection=await api<Collection>(event,'GET',path(event.url));
  const {rows,requested,limit,sort,query,error:tooLong}=filterState(params);
  const {cursor,paged,rejected}=pageCursor(event.url);
  const filterErrors:Record<number,string>={};
  // An exact count reads every matching record, so it runs only when asked for (count=1),
  // never on page navigation, and its failure leaves the page's records in place.
  const counted=params.get('count')==='1';
  const view={rows,limit,sort,search:query,cursor:cursor ?? null,paged,counted,limitInvalid:limit!==requested,idempotencyKey:`ui-${randomUUID()}`,
    sortError:null as string|null,queryError:null as string|null,count:null as number|null,countError:null as ApiError|null};
  if (!collection.ok) return {...view,collection:null,error:collection.error,filterErrors,page:null};
  // A query the authority would refuse is reported on its fields and never sent.
  const {definition,ready}=collection.data;
  const built=predicates(definition,rows,ready);
  const sortError=sort ? sortProblem(definition,ready,sort.field) : null;
  const {body,error}=queryBody(built.predicates,limit,sort,cursor), queryError=tooLong ?? error;
  if (Object.keys(built.errors).length || sortError || queryError)
    return {...view,collection:collection.data,error:null,filterErrors:built.errors,sortError,queryError,page:null};
  const [page,count]=rejected ? [rejected,null] : await Promise.all([
    api<{records:StoredRecord[];nextCursor:string|null;schemaVersion:number}>(event,'POST',[...path(event.url),'records','query'],{body}),
    counted ? api<number>(event,'POST',[...path(event.url),'records','count'],{body:built.predicates}) : null]);
  return {...view,collection:collection.data,error:page.ok ? null : page.error,filterErrors,page:page.ok ? page.data : null,
    count:count?.ok ? count.data : null,countError:count && !count.ok ? count.error : null};
};

export const actions:Actions={
  filter:async(event)=>{
    const {rows,requested,limit,sort,query,error}=filterState(new URLSearchParams([...await event.request.formData()].map(([name,value])=>[name,String(value)])));
    if (!error) redirect(303,`${event.url.pathname}?${query}`);
    return fail(400,{filter:{rows,limit,sort,limitInvalid:limit!==requested,filterErrors:{} as Record<number,string>,sortError:null,queryError:error}});
  },
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
    // Past its deadline, or under another credential, the key may not recover the write, so a retry could create it twice.
    if (attempt.refused) return fail(400,{create:{...values,error:attempt.refused},pending:attempt.pending});
    const {externalKey,data}=attempt.request as {externalKey:string;data:Record<string,unknown>};
    const result=await api<Receipt>(event,'POST',[...path(event.url),'records'],
      {body:{operation:'create',idempotencyKey:attempt.key,data,...(given(externalKey) ? {externalKey} : {})}});
    // A retry sent an earlier request, so the unsent draft stays in the editor.
    if (result.ok) return {created:result.data,pending:unresolvedAfter(attempt,null),
      draft:attempt.retry ? {raw,externalKey:draftKey} : null};
    return fail(result.status,{create:{...values,error:result.error},pending:unresolvedAfter(attempt,result.error)});
  }
};
