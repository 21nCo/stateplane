import { api } from './api';

type Context=Parameters<typeof api>[0];
const denials=new Set(['UNAUTHENTICATED','FORBIDDEN','NOT_FOUND']);

/** Check a key secret at the provider and in one space. Only UNAUTHENTICATED is
 * a provider rejection; an unavailable, throttled or failed check is not
 * determined and never reads as a verified revocation. */
export async function checkKey(context:Context,space:string,token:string) {
  const session=await api<{kind:string}>(context,'GET',['auth','session'],{token});
  if (!session.ok) return {kind:null,code:session.error.code,rejected:session.error.code==='UNAUTHENTICATED',space:null};
  // The provider authenticates the key; Stateplane authorizes it per space. A key
  // revoked here stays denied while its provider cleanup is pending.
  const here=await api(context,'GET',['spaces',space,'collections'],{token});
  return {kind:session.data.kind,code:null,rejected:false,space:here.ok ? {allowed:true,code:null,denied:false} :
    {allowed:false,code:here.error.code,denied:denials.has(here.error.code)}};
}
