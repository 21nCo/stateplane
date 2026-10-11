import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import { selectors } from '$lib/paths';
import { jsonObject } from '$lib/server/forms';
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
  const rows:FilterRow[]=params.getAll('field').map((field,index)=>({field,op:params.getAll('op')[index] ?? 'eq',
    value:params.getAll('value')[index] ?? ''})).filter(row=>row.field);
  const requested=Number(params.get('limit') ?? defaultLimit);
  const limit=Number.isInteger(requested) && requested>=1 && requested<=100 ? requested : defaultLimit;
  const sort=params.get('sort') ? {field:params.get('sort')!,direction:params.get('dir')==='desc' ? 'desc' : 'asc'} : undefined;
  const cursor=params.get('cursor') ?? undefined;
  const filterErrors:Record<number,string>={};
  const view={rows,limit,sort,cursor:cursor ?? null,limitInvalid:limit!==requested,idempotencyKey:`ui-${randomUUID()}`};
  if (!collection.ok) return {...view,collection:null,error:collection.error,filterErrors,page:null,count:null};
  const built=predicates(collection.data.definition,rows);
  if (Object.keys(built.errors).length) return {...view,collection:collection.data,error:null,filterErrors:built.errors,page:null,count:null};
  const [page,count]=await Promise.all([
    api<{records:StoredRecord[];nextCursor:string|null;schemaVersion:number}>(event,'POST',[...path(event.url),'records','query'],
      {body:{predicates:built.predicates,limit,...(sort ? {sort} : {}),...(cursor ? {cursor} : {})}}),
    api<number>(event,'POST',[...path(event.url),'records','count'],{body:built.predicates})]);
  const error:ApiError|null=page.ok ? (count.ok ? null : count.error) : page.error;
  return {...view,collection:collection.data,error,filterErrors,page:page.ok ? page.data : null,
    count:count.ok ? count.data : null};
};

export const actions:Actions={
  create:async(event)=>{
    const form=await event.request.formData();
    const raw=String(form.get('data')??'');
    const externalKey=String(form.get('externalKey')??'');
    const idempotencyKey=String(form.get('idempotencyKey')??'');
    const data=jsonObject(raw);
    const values={raw,externalKey,idempotencyKey,invalid:!data,error:null as ApiError|null};
    if (!data) return fail(400,{create:values});
    const result=await api<Receipt>(event,'POST',[...path(event.url),'records'],
      {body:{operation:'create',idempotencyKey,data,...(externalKey.trim() ? {externalKey} : {})}});
    return result.ok ? {created:result.data} : fail(result.status,{create:{...values,error:result.error}});
  }
};
