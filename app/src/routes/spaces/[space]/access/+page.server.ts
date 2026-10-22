import { fail } from '@sveltejs/kit';
import { api, pageCursor } from '$lib/server/api';
import { checkKey } from '$lib/server/keycheck';
import { grantExpired, grantable, issuance, lifetimes } from '$lib/server/grants';
import { carriedId, selectors } from '$lib/paths';
import type { ApiError } from '$lib/errors';
import type { Collection, Page } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export interface AgentKey { keyId:string; status:string; expiresAt:string; createdAt:string; revokedAt:string|null; providerRevokedAt:string|null;
  grants:{collectionId:string;capabilities:string[];expiresAt:string|null}[] }

// Discovery returns 8 collections per page; the grant form follows at most 12
// pages (96 collections) per load, and the free-text group names any other.
const collectionPages=12;
async function listCollections(event:Parameters<PageServerLoad>[0]) {
  const slugs:string[]=[];
  let cursor:string|undefined;
  for (let page=0;page<collectionPages;page++) {
    const result=await api<Page<Collection>>(event,'GET',['spaces',selectors(event.url).space,'collections'],{query:{cursor}});
    // A failed page is reported, never shown as an empty or truncated list.
    if (!result.ok) return {slugs,more:false,error:result.error as ApiError|null};
    slugs.push(...result.data.items.map(item=>item.definition.slug));
    if (result.data.cursor===null) return {slugs,more:false,error:null};
    cursor=result.data.cursor;
  }
  return {slugs,more:true,error:null};
}

export const load:PageServerLoad=async(event)=>{
  const {cursor,paged,rejected}=pageCursor(event.url);
  const [keys,collections]=await Promise.all([
    rejected ?? api<{items:AgentKey[];nextCursor:string|null}>(event,'GET',['spaces',selectors(event.url).space,'agent-keys'],{query:{cursor}}),
    listCollections(event)]);
  // A grant is judged against this load's clock, so the server and browser render alike.
  const now=Date.now();
  return {cursor:cursor ?? null,paged,error:keys.ok ? null : keys.error,capabilities:grantable,lifetimes,
    keys:keys.ok ? {...keys.data,items:keys.data.items.map(key=>({...key,
      grants:key.grants.map(grant=>({...grant,expired:grantExpired(grant,now)}))}))} : null,
    collections:collections.slugs,moreCollections:collections.more,collectionsError:collections.error};
};

export const actions:Actions={
  issue:async(event)=>{
    const request=issuance(await event.request.formData(),Date.now());
    if ('invalid' in request) return fail(400,{issueInvalid:true});
    // Refused before sending: the route would read no more than its limit.
    if ('tooLarge' in request) return fail(400,{issueTooLarge:request.tooLarge});
    const issued=await api<{keyId:string;secret:string;expiresAt:string}>(event,'POST',['spaces',selectors(event.url).space,'agent-keys'],
      {body:request.body});
    // The secret is rendered in this one response only; it is never stored or listed.
    // The enhanced form keeps it out of a replayable POST history entry.
    return issued.ok ? {issued:issued.data} : fail(issued.status,{issueError:issued.error});
  },
  revoke:async(event)=>{
    const keyId=carriedId(String((await event.request.formData()).get('keyId')??''));
    const result=await api(event,'DELETE',['spaces',selectors(event.url).space,'agent-keys',keyId]);
    // The failed key stays retryable here whatever the key list shows: a repeat
    // DELETE finishes the provider revocation and the space's policy publication.
    return result.ok ? {revoked:keyId} : fail(result.status,{revokeError:result.error,revokeKeyId:keyId});
  },
  check:async(event)=>{
    const token=String((await event.request.formData()).get('secret')??'').trim();
    const check=token ? await checkKey(event,selectors(event.url).space,token) : null;
    return check ? {check} : fail(400,{checkMissing:!token,checkMalformed:!!token});
  }
};
