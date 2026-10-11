import { api } from '$lib/server/api';
import { selectors } from '$lib/paths';
import type { PageServerLoad } from './$types';

interface EventPage { events:{eventId:string;recordId:string;revision:number;operation:string;schemaVersion:number;committedAt:string}[]; nextCursor:string|null }

export const load:PageServerLoad=async(event)=>{
  const cursor=event.url.searchParams.get('cursor') ?? undefined;
  const page=await api<EventPage>(event,'GET',['spaces',selectors(event.url).space,'collections',selectors(event.url).collection,'events'],{query:{cursor}});
  return {cursor:cursor ?? null,feed:page.ok ? page.data : null,error:page.ok ? null : page.error};
};
