import { api, pageCursor } from '$lib/server/api';
import { selectors } from '$lib/paths';
import type { PageServerLoad } from './$types';

interface AuditEntry { audit_id:string; action:string; credential_id:string|null; policy_version:number; placement_generation:number; recorded_at:string; details:Record<string,unknown> }

export const load:PageServerLoad=async(event)=>{
  const {cursor,paged,rejected}=pageCursor(event.url);
  const page=rejected ?? await api<{entries:AuditEntry[];nextCursor:string|null}>(event,'GET',['spaces',selectors(event.url).space,'audit'],{query:{cursor}});
  return {cursor:cursor ?? null,paged,audit:page.ok ? page.data : null,error:page.ok ? null : page.error};
};
