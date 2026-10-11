import { fail } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import type { Collection, Page } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export const load:PageServerLoad=async(event)=>{
  const cursor=event.url.searchParams.get('cursor') ?? undefined;
  const page=await api<Page<Collection>>(event,'GET',['spaces',event.params.space,'collections'],{query:{cursor}});
  return {cursor:cursor ?? null,collections:page.ok ? page.data : null,error:page.ok ? null : page.error};
};

export const actions:Actions={
  lifecycle:async(event)=>{
    const lifecycle=String((await event.request.formData()).get('lifecycle')??'');
    const result=await api(event,'PATCH',['spaces',event.params.space],{body:{lifecycle}});
    return result.ok ? {lifecycleSaved:true} : fail(result.status,{lifecycleError:result.error});
  }
};
