import { randomUUID } from 'node:crypto';
import { fail, redirect } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import type { Page, Space } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export const load:PageServerLoad=async(event)=>{
  const cursor=event.url.searchParams.get('cursor') ?? undefined;
  const page=await api<Page<Space>>(event,'GET',['spaces'],{query:{cursor}});
  // A fresh caller-selected ID lets a lost create response be retried by the same ID.
  return {cursor:cursor ?? null,page:page.ok ? page.data : null,error:page.ok ? null : page.error,newSpaceId:`sp_${randomUUID()}`};
};

export const actions:Actions={
  create:async(event)=>{
    const form=await event.request.formData();
    const spaceId=String(form.get('spaceId')??'');
    const cellId=String(form.get('cellId')??'').trim();
    const created=await api<Space>(event,'POST',['spaces'],{body:{spaceId,...(cellId ? {cellId} : {})}});
    if (!created.ok) return fail(created.status,{create:{error:created.error,spaceId,cellId}});
    redirect(303,`/spaces/${encodeURIComponent(created.data.spaceId)}`);
  },
  open:async({request})=>{
    const spaceId=String((await request.formData()).get('spaceId')??'').trim();
    if (!spaceId) return fail(400,{open:{missing:true}});
    redirect(303,`/spaces/${encodeURIComponent(spaceId)}`);
  }
};
