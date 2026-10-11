import { fail } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import { jsonObject } from '$lib/server/forms';
import type { Collection } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

// Each backfill call commits at most 100 rows; one click advances a bounded number of batches.
const backfillBatches=20;
const path=(params:{space:string;collection:string})=>['spaces',params.space,'collections',params.collection];

export const load:PageServerLoad=async(event)=>{
  const result=await api<Collection>(event,'GET',path(event.params));
  return {collection:result.ok ? result.data : null,error:result.ok ? null : result.error};
};

export const actions:Actions={
  revise:async(event)=>{
    const form=await event.request.formData();
    const definition=String(form.get('definition')??'');
    const version=Number(form.get('version'));
    const parsed=jsonObject(definition);
    if (!parsed) return fail(400,{definition,version,invalid:true});
    // If-Match carries the version the editor loaded; a concurrent revision is rejected, not replaced.
    const saved=await api(event,'PATCH',path(event.params),{headers:{'if-match':String(version)},
      body:{...parsed,slug:event.params.collection,version:version+1}});
    return saved.ok ? {revised:true} : fail(saved.status,{definition,version,error:saved.error});
  },
  backfill:async(event)=>{
    const field=String((await event.request.formData()).get('field')??'');
    for (let batch=0;batch<backfillBatches;batch++) {
      const result=await api<{ready:boolean}>(event,'POST',[...path(event.params),'indexes',field]);
      if (!result.ok) return fail(result.status,{field,backfillError:result.error});
      if (result.data.ready) return {field,ready:true};
    }
    return {field,ready:false};
  }
};
