import type { Cookies } from '@sveltejs/kit';
import type { ApiError } from '$lib/errors';
import { segment } from '../paths';
import { stateplaneHost, unavailable } from './host';
import type { Bindings, Host } from './host';

export const sessionCookie='stateplane_session';
export type ApiResult<T>={ok:true;status:number;data:T}|{ok:false;status:number;error:ApiError};
interface Context { cookies:Cookies; url:URL; platform?:App.Platform|undefined; locals?:App.Locals }
interface Options { body?:unknown; query?:Record<string,string|undefined>; headers?:Record<string,string>; token?:string }

/** A bearer is visible ASCII; anything else cannot form a valid header. */
export const bearer=(token:string)=>/^[\x21-\x7e]+$/.test(token);
export const bindings=(platform?:App.Platform)=>({...process.env,...platform?.env}) as unknown as Bindings;

/** A page render shares one Worker host, so it opens one pool rather than one
 * per call; hooks.server.ts retires it after the response. A host retired by a
 * request timeout is replaced instead of reused. */
function hostFor(context:Context):Host|undefined {
  const env=bindings(context.platform);
  const locals=context.locals;
  if (!locals) return stateplaneHost(env);
  const current=locals.hostLease;
  if (current && !current.retired()) return current.host;
  return stateplaneHost(env,lease=>{ locals.hostLease=lease; });
}

/** A stored session the API rejects is cleared, so / offers sign-in again
 * instead of returning the owner to pages that all fail. */
function rejected(context:Context,options:Options,requestId:string|null=null):ApiResult<never> {
  if (options.token===undefined) context.cookies.delete(sessionCookie,{path:'/'});
  return {ok:false,status:401,error:{code:'UNAUTHENTICATED',retryable:false,requestId}};
}

/** The page cursor in a page's query: an empty one means the first page. A
 * repeated cursor is rejected before any call, as /v1 rejects it. "paged" says
 * whether the request carried any cursor, so a failed page offers its restart
 * whatever value the cursor normalized to. */
export function pageCursor(url:URL):{cursor?:string;paged:boolean;rejected?:ApiResult<never>} {
  const all=url.searchParams.getAll('cursor');
  const cursor=all[0] || undefined;
  const paged=all.length>0;
  return all.length>1 ? {cursor,paged,rejected:{ok:false,status:400,error:{code:'CURSOR_INVALID',retryable:false,requestId:null}}} : {cursor,paged};
}

/** Send one request through the same /v1 handler, identity check and services as
 * every other transport. The UI holds no authority of its own: the bearer in its
 * HttpOnly cookie is verified by the API on every call. */
export async function api<T>(context:Context,method:string,path:readonly string[],options:Options={}):Promise<ApiResult<T>> {
  const token=options.token ?? context.cookies.get(sessionCookie);
  if (!token || !bearer(token)) return rejected(context,options);
  const url=new URL(`/v1/${path.map(segment).join('/')}`,context.url.origin);
  for (const [name,value] of Object.entries(options.query??{})) if (value!==undefined) url.searchParams.set(name,value);
  const headers:Record<string,string>={authorization:`Bearer ${token}`,...options.headers};
  let body:string|undefined;
  if (options.body!==undefined) {
    body=typeof options.body==='string' ? options.body : JSON.stringify(options.body);
    headers['content-type']='application/json';
  }
  const request=new Request(url,{method,headers,body});
  const host=hostFor(context);
  // Without a host the request was never sent, so it is retryable, as on /v1.
  const response=host ? await host.http(request) : unavailable();
  const value=await response.json().catch(()=>null) as {error?:Partial<ApiError>}|null;
  if (response.ok) return {ok:true,status:response.status,data:value as T};
  if (value?.error?.code==='UNAUTHENTICATED') return rejected(context,options,value.error.requestId ?? null);
  return {ok:false,status:response.status,error:{code:value?.error?.code ?? 'PROVIDER_UNAVAILABLE',
    retryable:value?.error?.retryable===true,requestId:value?.error?.requestId ?? null}};
}
