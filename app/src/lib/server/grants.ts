import { capabilities } from '@stateplane/contracts';
import type { Capability } from '@stateplane/contracts';
import { carriedId } from '../paths';

/** The issue form offers every capability the authority grants. */
export { capabilities as grantable } from '@stateplane/contracts';
const grantableSet=new Set<string>(capabilities);
// Lifetime presets keep issuance simple; the service still validates the instant.
export const lifetimes=[1,7,30,90];
/** Request-body bytes the /v1 issuance route reads before refusing it as
 * RATE_LIMITED (packages/api/src/http.ts). */
export const issueBodyLimit=16_384;
export interface IssueBody { expiresAt:string; grants:{collectionId:string;capabilities:Capability[]}[] }
const text=(value:FormDataEntryValue|null)=>typeof value==='string' ? value : '';

/** The issuance request a submitted form describes, or why it is not sent. */
export function issuance(form:FormData,now:number):{body:IssueBody}|{invalid:true}|{tooLarge:{bytes:number;limit:number}} {
  const days=Number(form.get('days'));
  // Collection IDs are exact API selectors: " items " and "items" are different collections.
  // Listed IDs are carried; the free-text name of the last group is sent as typed.
  const ids=[...form.getAll('collection').map(value=>carriedId(text(value))),text(form.get('other-collection'))];
  // A collection named in more than one group gets one grant with every chosen capability.
  const chosen=new Map<string,Set<Capability>>();
  ids.forEach((collectionId,index)=>{
    const picked=form.getAll(`capabilities-${index}`).map(text).filter((item):item is Capability=>grantableSet.has(item));
    if (collectionId && picked.length) chosen.set(collectionId,new Set([...chosen.get(collectionId) ?? [],...picked]));
  });
  const grants=[...chosen].map(([collectionId,picked])=>({collectionId,capabilities:[...picked]}));
  if (!lifetimes.includes(days) || !grants.length) return {invalid:true};
  const body={expiresAt:new Date(now+days*86_400_000).toISOString(),grants};
  // api() sends JSON.stringify(body); measure the same UTF-8 bytes the route counts.
  const bytes=new TextEncoder().encode(JSON.stringify(body)).byteLength;
  return bytes>issueBodyLimit ? {tooLarge:{bytes,limit:issueBodyLimit}} : {body};
}

/** A listed grant past its own deadline no longer authorizes, even while its key is active. */
export const grantExpired=(grant:{expiresAt:string|null},now:number)=>grant.expiresAt!==null && Date.parse(grant.expiresAt)<=now;
