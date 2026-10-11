import { sessionCookie } from '$lib/server/api';
import type { LayoutServerLoad } from './$types';

export const load:LayoutServerLoad=({cookies})=>({signedIn:!!cookies.get(sessionCookie)});
