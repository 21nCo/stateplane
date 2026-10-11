import { mcpUnavailable, stateplaneHost } from '$lib/server/host';
import type { Bindings } from '$lib/server/host';
import type { RequestHandler } from './$types';

/** OAuth protected-resource metadata for the /mcp resource. */
export const GET:RequestHandler=({request,platform})=>{
  const env={...process.env,...platform?.env} as unknown as Bindings;
  return stateplaneHost(env)?.mcp(request) ?? mcpUnavailable();
};
