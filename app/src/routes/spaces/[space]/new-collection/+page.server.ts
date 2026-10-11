import { fail, redirect } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import { collectionHref, selectors } from '$lib/paths';
import { jsonObject } from '$lib/server/forms';
import type { Actions } from './$types';

export const actions:Actions={
  default:async(event)=>{
    const form=await event.request.formData();
    // The name is an exact selector; only a blank name is rejected here.
    const slug=String(form.get('slug')??'');
    const definition=String(form.get('definition')??'');
    const parsed=jsonObject(definition);
    if (!slug.trim() || !parsed) return fail(400,{slug,definition,missingSlug:!slug.trim(),invalid:!parsed});
    const saved=await api(event,'PUT',['spaces',selectors(event.url).space,'collections',slug],{body:{...parsed,slug,version:1}});
    if (!saved.ok) return fail(saved.status,{slug,definition,error:saved.error});
    redirect(303,`${collectionHref(selectors(event.url).space,slug)}/schema`);
  }
};
