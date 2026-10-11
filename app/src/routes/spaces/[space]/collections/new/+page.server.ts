import { fail, redirect } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import { jsonObject } from '$lib/server/forms';
import type { Actions } from './$types';

export const actions:Actions={
  default:async(event)=>{
    const form=await event.request.formData();
    const slug=String(form.get('slug')??'').trim();
    const definition=String(form.get('definition')??'');
    const parsed=jsonObject(definition);
    if (!slug || !parsed) return fail(400,{slug,definition,missingSlug:!slug,invalid:!parsed});
    const saved=await api(event,'PUT',['spaces',event.params.space,'collections',slug],{body:{...parsed,slug,version:1}});
    if (!saved.ok) return fail(saved.status,{slug,definition,error:saved.error});
    redirect(303,`/spaces/${encodeURIComponent(event.params.space)}/collections/${encodeURIComponent(slug)}/schema`);
  }
};
