import { fail } from '@sveltejs/kit';
import { api } from '$lib/server/api';
import { checkKey } from '$lib/server/keycheck';
import { selectors } from '$lib/paths';
import type { Collection, Page } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export interface AgentKey { keyId:string; status:string; expiresAt:string; createdAt:string; revokedAt:string|null; providerRevokedAt:string|null;
  grants:{collectionId:string;capabilities:string[];expiresAt:string|null}[] }
const grantable=['records:read','records:write','events:read','schema:write','space:admin'];
// Lifetime presets keep issuance simple; the service still validates the instant.
const lifetimes=new Set([1,7,30,90]);

// Discovery returns 8 collections per page; the grant form follows at most 12
// pages (96 collections) per load, and the free-text group names any other.
const collectionPages=12;
async function listCollections(event:Parameters<PageServerLoad>[0]) {
  const slugs:string[]=[];
  let cursor:string|undefined;
  for (let page=0;page<collectionPages;page++) {
    const result=await api<Page<Collection>>(event,'GET',['spaces',selectors(event.url).space,'collections'],{query:{cursor}});
    if (!result.ok) return {slugs,more:slugs.length>0};
    slugs.push(...result.data.items.map(item=>item.definition.slug));
    if (result.data.cursor===null) return {slugs,more:false};
    cursor=result.data.cursor;
  }
  return {slugs,more:true};
}

export const load:PageServerLoad=async(event)=>{
  const cursor=event.url.searchParams.get('cursor') ?? undefined;
  const [keys,collections]=await Promise.all([
    api<{items:AgentKey[];nextCursor:string|null}>(event,'GET',['spaces',selectors(event.url).space,'agent-keys'],{query:{cursor}}),
    listCollections(event)]);
  return {cursor:cursor ?? null,keys:keys.ok ? keys.data : null,error:keys.ok ? null : keys.error,
    collections:collections.slugs,moreCollections:collections.more};
};

export const actions:Actions={
  issue:async(event)=>{
    const form=await event.request.formData();
    const days=Number(form.get('days'));
    // Collection IDs are exact API selectors: " items " and "items" are different collections.
    const grants=form.getAll('collection').map((value,index)=>({collectionId:String(value),
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
    return {check:await checkKey(event,selectors(event.url).space,token)};
  }
};
