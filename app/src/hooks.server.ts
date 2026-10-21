import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit';
import { sessionCookie } from './lib/server/api';

// app.html ends the head with a fallback title; a page that sets its own keeps only that one.
const fallback='<title>Stateplane</title></head>';
const singleTitle=({html}:{html:string})=>{
  const at=html.indexOf(fallback);
  return at>0 && html.lastIndexOf('<title>',at-1)>=0 ? html.slice(0,at)+'</head>'+html.slice(at+fallback.length) : html;
};
// SvelteKit routes on the decoded path, so /%73paces is /spaces; it answers a malformed one with 400.
const routed=(url:URL)=>{
  try { return url.pathname.split('%25').map(decodeURI).join('%25'); } catch { return url.pathname; }
};

/** Pages require a session cookie; the API still verifies it on every call.
 * A document GET gets a 303 no cache keeps. SvelteKit answers the thrown
 * redirect as the data, remote or form action result the client expects
 * (test/ui-shell.test.ts, test/e2e/foundation.spec.ts). No referrer leaves the
 * app, because page cursors appear in query strings. */
export const handle:Handle=async({event,resolve})=>{
  const path=routed(event.url);
  if (path.startsWith('/spaces') && !event.cookies.get(sessionCookie)) {
    if (['GET','HEAD'].includes(event.request.method) && !event.isDataRequest && !event.isRemoteRequest)
      return new Response(null,{status:303,headers:{location:'/','Cache-Control':'no-store'}});
    redirect(303,'/');
  }
  let response:Response;
  try { response=await resolve(event,{transformPageChunk:singleTitle}); }
  finally { event.locals.hostLease?.retire(); }
  response.headers.set('Referrer-Policy','no-referrer');
  response.headers.set('X-Content-Type-Options','nosniff');
  if (path.startsWith('/spaces') || path==='/') response.headers.set('Cache-Control','no-store');
  return response;
};
