import { fail, redirect } from '@sveltejs/kit';
import { api, sessionCookie } from '$lib/server/api';
import type { Actions, PageServerLoad } from './$types';

export const load:PageServerLoad=({cookies})=>{ if (cookies.get(sessionCookie)) redirect(303,'/spaces'); };

export const actions:Actions={
  default:async(event)=>{
    const token=String((await event.request.formData()).get('token')??'').trim();
    if (!token) return fail(400,{missing:true});
    // The API decides whether the bearer is valid; the UI stores only what it verified.
    const session=await api<{kind:'session'|'api-key'}>(event,'GET',['auth','session'],{token});
    if (!session.ok) return fail(session.status,{error:session.error});
    event.cookies.set(sessionCookie,token,{path:'/',httpOnly:true,sameSite:'strict',
      secure:event.url.protocol==='https:',maxAge:8*3600});
    redirect(303,'/spaces');
  }
};
