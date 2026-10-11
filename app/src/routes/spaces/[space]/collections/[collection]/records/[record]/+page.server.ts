import { randomUUID } from 'node:crypto';
import { fail, redirect } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import { jsonObject } from '$lib/server/forms';
import type { Receipt, StoredRecord } from '$lib/types';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

const recordPath=(params:{space:string;collection:string;record:string})=>
  ['spaces',params.space,'collections',params.collection,'records',params.record];
const pretty=(record:StoredRecord)=>JSON.stringify(JSON.parse(record.canonicalData),null,2);

export const load:PageServerLoad=async(event)=>{
  const [record,projection]=await Promise.all([api<StoredRecord>(event,'GET',recordPath(event.params)),
    api<{state:string;generation:number;revision:number}>(event,'GET',[...recordPath(event.params),'projection'])]);
  return {record:record.ok ? {...record.data,pretty:pretty(record.data)} : null,error:record.ok ? null : record.error,
    projection:projection.ok ? projection.data : null,idempotencyKey:`ui-${randomUUID()}`};
};

/** Never resolve a stale write silently: return the current record beside the user's draft. */
async function conflict(event:RequestEvent,values:Record<string,unknown>) {
  const current=await api<StoredRecord>(event,'GET',recordPath(event.params));
  return fail(409,{...values,conflict:current.ok ? {revision:current.data.revision,pretty:pretty(current.data)} : {deleted:true}});
}

export const actions:Actions={
  save:async(event)=>{
    const form=await event.request.formData();
    const raw=String(form.get('data')??'');
    const idempotencyKey=String(form.get('idempotencyKey')??'');
    const expectedRevision=Number(form.get('expectedRevision'));
    const values={raw,idempotencyKey,expectedRevision};
    const data=jsonObject(raw);
    if (!data) return fail(400,{...values,invalid:true});
    const result=await api<Receipt>(event,'POST',recordPath(event.params).slice(0,5),
      {body:{operation:'replace',id:event.params.record,expectedRevision,idempotencyKey,data}});
    if (result.ok) return {saved:result.data};
    if (result.error.code==='REVISION_CONFLICT') return conflict(event,values);
    return fail(result.status,{...values,error:result.error});
  },
  delete:async(event)=>{
    const form=await event.request.formData();
    const idempotencyKey=String(form.get('idempotencyKey')??'');
    const expectedRevision=Number(form.get('expectedRevision'));
    const result=await api<Receipt>(event,'POST',recordPath(event.params).slice(0,5),
      {body:{operation:'delete',id:event.params.record,expectedRevision,idempotencyKey}});
    if (result.ok) redirect(303,`/spaces/${encodeURIComponent(event.params.space)}/collections/${encodeURIComponent(event.params.collection)}`);
    if (result.error.code==='REVISION_CONFLICT') return conflict(event,{deleting:true,idempotencyKey,expectedRevision});
    return fail(result.status,{deleting:true,idempotencyKey,expectedRevision,deleteError:result.error});
  }
};
