import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { api, pageCursor } from '$lib/server/api';
import { carriedId, selectors } from '$lib/paths';
import { given, jsonObject, retainedSent, retried, writeIdentity } from '$lib/server/forms';
import { predicates } from '$lib/query';
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
  const {cursor,rejected}=pageCursor(event.url);
  const filterErrors:Record<number,string>={};
  const view={rows,limit,sort,cursor:cursor ?? null,limitInvalid:limit!==requested,idempotencyKey:`ui-${randomUUID()}`};
  if (!collection.ok) return {...view,collection:null,error:collection.error,filterErrors,page:null,count:null};
  const built=predicates(collection.data.definition,rows);
  if (Object.keys(built.errors).length) return {...view,collection:collection.data,error:null,filterErrors:built.errors,page:null,count:null};
  const [page,count]=rejected ? [rejected,rejected] : await Promise.all([
    api<{records:StoredRecord[];nextCursor:string|null;schemaVersion:number}>(event,'POST',[...path(event.url),'records','query'],
      {body:{predicates:built.predicates,limit,...(sort ? {sort} : {}),...(cursor!==undefined ? {cursor} : {})}}),
    api<number>(event,'POST',[...path(event.url),'records','count'],{body:built.predicates})]);
  const error:ApiError|null=page.ok ? (count.ok ? null : count.error) : page.error;
  return {...view,collection:collection.data,error,filterErrors,page:page.ok ? page.data : null,
    count:count.ok ? count.data : null};
};

export const actions:Actions={
  create:async(event)=>{
    const form=await event.request.formData();
    // The editor's text always stays the draft; a retry resends the retained request instead.
    const raw=String(form.get('data')??'');
    const retry=retried(form);
    const draftKey=String(form.get('externalKey')??'');
    const externalKey=retry ? String(retry.externalKey) : draftKey;
    const data=retry ? jsonObject(JSON.stringify(retry.data)) : jsonObject(raw);
    // A rejected draft keeps any retained request and key for a later retry.
    const kept={idempotencyKey:String(form.get('idempotencyKey')??''),sent:retainedSent(form)};
    const blank={raw,externalKey:draftKey,invalid:!data,error:null as ApiError|null};
    if (!data) return fail(400,{create:{...blank,...kept}});
    const {sent,idempotencyKey}=writeIdentity(form,{externalKey,data});
    const values={...blank,idempotencyKey,sent};
    const result=await api<Receipt>(event,'POST',[...path(event.url),'records'],
      {body:{operation:'create',idempotencyKey,data,...(given(externalKey) ? {externalKey} : {})}});
    return result.ok ? {created:result.data} : fail(result.status,{create:{...values,error:result.error}});
  }
};
