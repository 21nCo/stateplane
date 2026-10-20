import type { Handle } from '@sveltejs/kit';
import { sessionCookie } from './lib/server/api';

// app.html ends the head with a fallback title; a page that sets its own keeps only that one.
const fallback='<title>Stateplane</title></head>';
const singleTitle=({html}:{html:string})=>{
  const at=html.indexOf(fallback);
  return at>0 && html.lastIndexOf('<title>',at-1)>=0 ? html.slice(0,at)+'</head>'+html.slice(at+fallback.length) : html;
};

/** Pages require a session cookie; the API still verifies it on every call.
 * SvelteKit answers a client navigation's data request with this 303 as a data
 * redirect (test/e2e/foundation.spec.ts). No referrer leaves the app, because
 * page cursors appear in query strings. */
export const handle:Handle=async({event,resolve})=>{
  if (event.url.pathname.startsWith('/spaces') && !event.cookies.get(sessionCookie))
    return new Response(null,{status:303,headers:{location:'/','Cache-Control':'no-store'}});
  let response:Response;
  try { response=await resolve(event,{transformPageChunk:singleTitle}); }
  finally { event.locals.hostLease?.retire(); }
  response.headers.set('Referrer-Policy','no-referrer');
  response.headers.set('X-Content-Type-Options','nosniff');
  if (event.url.pathname.startsWith('/spaces') || event.url.pathname==='/') response.headers.set('Cache-Control','no-store');
  return response;
};
