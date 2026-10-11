import { randomUUID } from 'node:crypto';
import { fail, redirect } from '@sveltejs/kit';
import { api, pageCursor } from '$lib/server/api';
import { given } from '$lib/server/forms';
import { carriedId, spaceHref } from '$lib/paths';
import type { Page, Space } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export const load:PageServerLoad=async(event)=>{
  const {cursor,rejected}=pageCursor(event.url);
  const page=rejected ?? await api<Page<Space>>(event,'GET',['spaces'],{query:{cursor}});
  // A fresh caller-selected ID lets a lost create response be retried by the same ID.
  return {cursor:cursor ?? null,page:page.ok ? page.data : null,error:page.ok ? null : page.error,newSpaceId:`sp_${randomUUID()}`};
};

export const actions:Actions={
  create:async(event)=>{
    const form=await event.request.formData();
    const spaceId=String(form.get('spaceId')??'');
    const cellId=String(form.get('cellId')??'');
    const created=await api<Space>(event,'POST',['spaces'],{body:{spaceId,...(given(cellId) ? {cellId} : {})}});
    if (!created.ok) return fail(created.status,{create:{error:created.error,spaceId,cellId}});
    redirect(303,spaceHref(created.data.spaceId));
  },
  open:async({request})=>{
    // The switcher carries a listed space ID; the open form sends the typed ID exactly.
    const form=await request.formData();
    const spaceId=form.has('listed') ? carriedId(String(form.get('listed'))) : String(form.get('spaceId')??'');
    if (!given(spaceId)) return fail(400,{open:{missing:true}});
    redirect(303,spaceHref(spaceId));
  }
};
