import type { Handle } from '@sveltejs/kit';
import { sessionCookie } from './lib/server/api';

/** Pages require a session cookie; the API still verifies it on every call.
 * No referrer leaves the app, because page cursors appear in query strings. */
export const handle:Handle=async({event,resolve})=>{
  if (event.url.pathname.startsWith('/spaces') && !event.cookies.get(sessionCookie))
    return new Response(null,{status:303,headers:{location:'/','Cache-Control':'no-store'}});
  let response:Response;
  try { response=await resolve(event); }
  finally { event.locals.hostLease?.retire(); }
  response.headers.set('Referrer-Policy','no-referrer');
  response.headers.set('X-Content-Type-Options','nosniff');
  if (event.url.pathname.startsWith('/spaces') || event.url.pathname==='/') response.headers.set('Cache-Control','no-store');
  return response;
};
