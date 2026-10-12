import { redirect } from '@sveltejs/kit';
import { sessionCookie } from '$lib/server/api';
import type { RequestHandler } from './$types';

/** SvelteKit's origin check rejects a cross-site sign-out form. */
export const POST:RequestHandler=({cookies})=>{ cookies.delete(sessionCookie,{path:'/'}); redirect(303,'/'); };
