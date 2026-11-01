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

// The /v1 API authenticates a bearer header only and never reads cookies, so a
// cross-site form post cannot act as anyone there; it takes raw uploads of any
// MIME type, from clients that send no Origin.
const bearerOnly='/v1/[...path]';
// The form types SvelteKit checks, and none at all, as a bodyless no-cors fetch
// sends. All but application/x-sveltekit-formdata can be sent cross-site without
// a CORS preflight; that one needs a preflight and is kept only to match SvelteKit.
const formTypes=new Set(['','application/x-www-form-urlencoded','multipart/form-data','text/plain','application/x-sveltekit-formdata']);
/** Whether a browser sent the request from this origin. Pages are served with
 * Referrer-Policy: no-referrer, under which a browser's own form post carries
 * `Origin: null`, so its Sec-Fetch-Site, which no page can set, also counts. */
const sameOrigin=(request:Request,url:URL)=>
  request.headers.get('origin')===url.origin || request.headers.get('sec-fetch-site')==='same-origin';
/** SvelteKit's own cross-site form check (disabled in svelte.config.js), for
 * every route but the bearer-only API: pages, form actions and sign-out keep it.
 * Unlike SvelteKit's, it also applies in development and to a request without
 * a Content-Type, such as a bodyless sign-out. */
function crossSite({request,url,route}:Parameters<Handle>[0]['event']):Response|null {
  if (!['POST','PUT','PATCH','DELETE'].includes(request.method) || route?.id===bearerOnly) return null;
  const type=request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase() ?? '';
  if (!formTypes.has(type) || sameOrigin(request,url)) return null;
  const message=`Cross-site ${request.method} form submissions are forbidden`;
  return request.headers.get('accept')==='application/json' ? Response.json({message},{status:403}) :
    new Response(message,{status:403,headers:{'content-type':'text/plain;charset=UTF-8'}});
}

/** Pages require a session cookie; the API still verifies it on every call.
 * A document GET gets a 303 no cache keeps. SvelteKit answers the thrown
 * redirect as the data, remote or form action result the client expects
 * (test/ui-shell.test.ts, test/e2e/foundation.spec.ts). No referrer leaves the
 * app, because page cursors appear in query strings. */
export const handle:Handle=async({event,resolve})=>{
  const forbidden=crossSite(event);
  if (forbidden) return forbidden;
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
