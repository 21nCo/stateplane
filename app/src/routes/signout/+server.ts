import { redirect } from '@sveltejs/kit';
import { sessionCookie } from '$lib/server/api';
import type { RequestHandler } from './$types';

/** The cross-site form check in hooks.server.ts rejects a cross-site sign-out form. */
export const POST:RequestHandler=({cookies})=>{ cookies.delete(sessionCookie,{path:'/'}); redirect(303,'/'); };
