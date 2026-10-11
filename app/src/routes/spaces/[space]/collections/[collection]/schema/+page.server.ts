import { fail } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import { selectors } from '$lib/paths';
import { jsonObject } from '$lib/server/forms';
import type { Collection } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

// Each backfill call commits at most 100 rows; one click advances a bounded number of batches.
const backfillBatches=20;
const path=(url:URL)=>{ const {space,collection}=selectors(url); return ['spaces',space,'collections',collection]; };

export const load:PageServerLoad=async(event)=>{
  const result=await api<Collection>(event,'GET',path(event.url));
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
    const saved=await api(event,'PATCH',path(event.url),{headers:{'if-match':String(version)},
      body:{...parsed,slug:selectors(event.url).collection,version:version+1}});
    return saved.ok ? {revised:version+1} : fail(saved.status,{definition,version,error:saved.error});
  },
  backfill:async(event)=>{
    const field=String((await event.request.formData()).get('field')??'');
    for (let batch=0;batch<backfillBatches;batch++) {
      const result=await api<{ready:boolean}>(event,'POST',[...path(event.url),'indexes',field]);
      if (!result.ok) return fail(result.status,{field,backfillError:result.error});
      if (result.data.ready) return {field,ready:true};
    }
    return {field,ready:false};
  }
};
