import { fail } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import { selectors } from '$lib/paths';
import type { Collection, Page } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export interface AgentKey { keyId:string; status:string; expiresAt:string; createdAt:string; revokedAt:string|null; providerRevokedAt:string|null;
  grants:{collectionId:string;capabilities:string[];expiresAt:string|null}[] }
const grantable=['records:read','records:write','events:read','schema:write','space:admin'];
// Lifetime presets keep issuance simple; the service still validates the instant.
const lifetimes=new Set([1,7,30,90]);

export const load:PageServerLoad=async(event)=>{
  const cursor=event.url.searchParams.get('cursor') ?? undefined;
  const [keys,collections]=await Promise.all([
    api<{items:AgentKey[];nextCursor:string|null}>(event,'GET',['spaces',selectors(event.url).space,'agent-keys'],{query:{cursor}}),
    api<Page<Collection>>(event,'GET',['spaces',selectors(event.url).space,'collections'])]);
  return {cursor:cursor ?? null,keys:keys.ok ? keys.data : null,error:keys.ok ? null : keys.error,
    collections:collections.ok ? collections.data.items.map(item=>item.definition.slug) : [],
    moreCollections:collections.ok && collections.data.cursor!==null};
};

export const actions:Actions={
  issue:async(event)=>{
    const form=await event.request.formData();
    const days=Number(form.get('days'));
    const grants=form.getAll('collection').map((value,index)=>({collectionId:String(value).trim(),
      capabilities:form.getAll(`capabilities-${index}`).map(String).filter(item=>grantable.includes(item))}))
      .filter(grant=>grant.collectionId && grant.capabilities.length);
    if (!lifetimes.has(days) || !grants.length) return fail(400,{issueInvalid:true});
    const expiresAt=new Date(Date.now()+days*86_400_000).toISOString();
    const issued=await api<{keyId:string;secret:string;expiresAt:string}>(event,'POST',['spaces',selectors(event.url).space,'agent-keys'],
      {body:{expiresAt,grants}});
    // The secret is rendered in this one response only; it is never stored or listed.
    return issued.ok ? {issued:issued.data} : fail(issued.status,{issueError:issued.error});
  },
  revoke:async(event)=>{
    const keyId=String((await event.request.formData()).get('keyId')??'');
    const result=await api(event,'DELETE',['spaces',selectors(event.url).space,'agent-keys',keyId]);
    return result.ok ? {revoked:keyId} : fail(result.status,{revokeError:result.error});
  },
  check:async(event)=>{
    const token=String((await event.request.formData()).get('secret')??'').trim();
    if (!token) return fail(400,{checkMissing:true});
    const result=await api<{kind:string}>(event,'GET',['auth','session'],{token});
    return {check:result.ok ? {accepted:true,kind:result.data.kind} : {accepted:false,code:result.error.code}};
  }
};
