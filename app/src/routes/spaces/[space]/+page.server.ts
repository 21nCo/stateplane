import { fail, redirect } from '@sveltejs/kit';
import { api, pageCursor } from '$lib/server/api';
import { given } from '$lib/server/forms';
import { collectionHref, selectors } from '$lib/paths';
import type { Collection, Page } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export const load:PageServerLoad=async(event)=>{
  const {cursor,paged,rejected}=pageCursor(event.url);
  const page=rejected ?? await api<Page<Collection>>(event,'GET',['spaces',selectors(event.url).space,'collections'],{query:{cursor}});
  return {cursor:cursor ?? null,paged,collections:page.ok ? page.data : null,error:page.ok ? null : page.error};
};

export const actions:Actions={
  lifecycle:async(event)=>{
    const lifecycle=String((await event.request.formData()).get('lifecycle')??'');
    const result=await api(event,'PATCH',['spaces',selectors(event.url).space],{body:{lifecycle}});
    return result.ok ? {lifecycleSaved:true} : fail(result.status,{lifecycleError:result.error});
  },
  open:async(event)=>{
    // Discovery needs record or schema access, so a key that may read only a
    // collection's changes opens them by the collection's exact name.
    const form=await event.request.formData();
    const collection=String(form.get('collection')??'');
    if (!given(collection)) return fail(400,{open:{missing:true}});
    const href=collectionHref(selectors(event.url).space,collection);
    redirect(303,form.get('view')==='events' ? `${href}/events` : href);
  }
};
