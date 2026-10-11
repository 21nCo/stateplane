import { api } from '$lib/server/api';
import type { Page, Space } from '$lib/types';
import type { LayoutServerLoad } from './$types';

/** Agent keys without space:admin cannot read placement; their granted collections still work. */
export const load:LayoutServerLoad=async(event)=>{
  const [space,spaces]=await Promise.all([api<Space>(event,'GET',['spaces',event.params.space]),
    api<Page<Space>>(event,'GET',['spaces'])]);
  return {spaceId:event.params.space,space:space.ok ? space.data : null,spaceError:space.ok ? null : space.error,
    switchable:spaces.ok ? spaces.data.items : []};
};
