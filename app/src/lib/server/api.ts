import type { Cookies } from '@sveltejs/kit';
import type { ApiError } from '$lib/errors';
import { segment } from '../paths';
import { stateplaneHost, unavailable } from './host';
import type { Bindings } from './host';

export const sessionCookie='stateplane_session';
export type ApiResult<T>={ok:true;status:number;data:T}|{ok:false;status:number;error:ApiError};
interface Context { cookies:Cookies; url:URL; platform?:App.Platform|undefined }
interface Options { body?:unknown; query?:Record<string,string|undefined>; headers?:Record<string,string>; token?:string }

export const bindings=(platform?:App.Platform)=>({...process.env,...platform?.env}) as unknown as Bindings;

/** Send one request through the same /v1 handler, identity check and services as
 * every other transport. The UI holds no authority of its own: the bearer in its
 * HttpOnly cookie is verified by the API on every call. */
export async function api<T>(context:Context,method:string,path:readonly string[],options:Options={}):Promise<ApiResult<T>> {
  const token=options.token ?? context.cookies.get(sessionCookie);
  // A bearer is visible ASCII; anything else cannot form a valid header.
  if (!token || !/^[\x21-\x7e]+$/.test(token)) return {ok:false,status:401,error:{code:'UNAUTHENTICATED',retryable:false,requestId:null}};
  const url=new URL(`/v1/${path.map(segment).join('/')}`,context.url.origin);
  for (const [name,value] of Object.entries(options.query??{})) if (value!==undefined) url.searchParams.set(name,value);
  const headers:Record<string,string>={authorization:`Bearer ${token}`,...options.headers};
  let body:string|undefined;
  if (options.body!==undefined) {
    body=typeof options.body==='string' ? options.body : JSON.stringify(options.body);
    headers['content-type']='application/json';
  }
  const request=new Request(url,{method,headers,body});
  const host=stateplaneHost(bindings(context.platform));
  // Without a host the request was never sent, so it is retryable, as on /v1.
  const response=host ? await host.http(request) : unavailable();
  const value=await response.json().catch(()=>null) as {error?:Partial<ApiError>}|null;
  if (response.ok) return {ok:true,status:response.status,data:value as T};
  return {ok:false,status:response.status,error:{code:value?.error?.code ?? 'PROVIDER_UNAVAILABLE',
    retryable:value?.error?.retryable===true,requestId:value?.error?.requestId ?? null}};
}
