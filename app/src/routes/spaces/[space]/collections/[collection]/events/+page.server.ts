import { api, pageCursor } from '$lib/server/api';
import { selectors } from '$lib/paths';
import type { PageServerLoad } from './$types';

interface EventPage { events:{eventId:string;recordId:string;revision:number;operation:string;schemaVersion:number;committedAt:string}[]; nextCursor:string|null }

export const load:PageServerLoad=async(event)=>{
  const {cursor,paged,rejected}=pageCursor(event.url);
  const page=rejected ?? await api<EventPage>(event,'GET',['spaces',selectors(event.url).space,'collections',selectors(event.url).collection,'events'],{query:{cursor}});
  return {cursor:cursor ?? null,paged,feed:page.ok ? page.data : null,error:page.ok ? null : page.error};
};
