import { fail, redirect } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import { collectionHref, selectors } from '$lib/paths';
import { given, jsonObject } from '$lib/server/forms';
import type { Actions } from './$types';

export const actions:Actions={
  default:async(event)=>{
    const form=await event.request.formData();
    // The name is an exact selector; only an empty name is rejected here.
    const slug=String(form.get('slug')??'');
    const definition=String(form.get('definition')??'');
    const parsed=jsonObject(definition);
    if (!given(slug) || !parsed) return fail(400,{slug,definition,missingSlug:!given(slug),invalid:!parsed});
    const saved=await api(event,'PUT',['spaces',selectors(event.url).space,'collections',slug],{body:{...parsed,slug,version:1}});
    // Define has no request key; on define SCHEMA_CONFLICT means the name is taken.
    if (!saved.ok) return fail(saved.status,{slug,definition,error:saved.error,exists:saved.error.code==='SCHEMA_CONFLICT'});
    redirect(303,`${collectionHref(selectors(event.url).space,slug)}/schema`);
  }
};
