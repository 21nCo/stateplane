import { api } from '$lib/server/api';
import { selectors } from '$lib/paths';
import type { Page, Space } from '$lib/types';
import type { LayoutServerLoad } from './$types';

/** Agent keys without space:admin cannot read placement; their granted collections still work. */
export const load:LayoutServerLoad=async(event)=>{
  const spaceId=selectors(event.url).space;
  const [space,spaces]=await Promise.all([api<Space>(event,'GET',['spaces',spaceId]),
    api<Page<Space>>(event,'GET',['spaces'])]);
  // The switcher lists the first page; the open space is always its selected
  // option even when it sits on a later page. The space list reaches the rest.
  const ids=spaces.ok ? spaces.data.items.map(item=>item.spaceId) : [];
  return {spaceId,space:space.ok ? space.data : null,spaceError:space.ok ? null : space.error,
    switchable:ids.length && !ids.includes(spaceId) ? [spaceId,...ids] : ids,moreSpaces:spaces.ok && spaces.data.cursor!==null};
};
