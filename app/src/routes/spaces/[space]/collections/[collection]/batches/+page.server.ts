import { fail, redirect } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import type { Receipt } from '$lib/types';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export interface Progress { operationKey:string; state:'active'|'cancelled'; items:{ordinal:number;state:string;attempts:number;failureCode:string|null;receipt:Receipt|null}[] }
// The authority accepts 1–20 items per operation; reject a larger manifest before sending it.
const maxItems=20;
const batchPath=(event:RequestEvent,key:string)=>['spaces',event.params.space,'collections',event.params.collection,'batches',key];
const here=(event:RequestEvent,key:string)=>`${event.url.pathname}?operation=${encodeURIComponent(key)}`;

export const load:PageServerLoad=async(event)=>{
  const operation=event.url.searchParams.get('operation') ?? '';
  if (!operation) return {operation,progress:null,error:null};
  const result=await api<Progress>(event,'GET',batchPath(event,operation));
  return {operation,progress:result.ok ? result.data : null,error:result.ok ? null : result.error};
};

export const actions:Actions={
  ingest:async(event)=>{
    const form=await event.request.formData();
    const operationKey=String(form.get('operationKey')??'').trim();
    const items=String(form.get('items')??'');
    const retryFailed=form.get('retryFailed')==='on';
    // Each nonblank line is sent as its exact text; reformatting a line changes the batch identity.
    const lines=items.split(/\r?\n/).filter(line=>line.trim());
    const values={operationKey,items,retryFailed};
    if (!operationKey) return fail(400,{...values,keyMissing:true});
    if (!lines.length || lines.length>maxItems) return fail(400,{...values,countInvalid:true});
    const result=await api<Progress>(event,'PUT',batchPath(event,operationKey),{body:lines,query:{retryFailed:retryFailed ? 'true' : undefined}});
    if (!result.ok) return fail(result.status,{...values,error:result.error});
    redirect(303,here(event,operationKey));
  },
  cancel:async(event)=>{
    const operationKey=String((await event.request.formData()).get('operationKey')??'');
    const result=await api<Progress>(event,'DELETE',batchPath(event,operationKey));
    if (!result.ok) return fail(result.status,{cancelError:result.error});
    redirect(303,here(event,operationKey));
  }
};
