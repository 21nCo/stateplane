import { mcpUnavailable, stateplaneHost } from '$lib/server/host';
import type { Bindings } from '$lib/server/host';
import type { RequestHandler } from './$types';

/** Streamable HTTP MCP over the same opt-in host and services as /v1. */
const handle:RequestHandler=({request,platform})=>{
  const env={...process.env,...platform?.env} as unknown as Bindings;
  return stateplaneHost(env)?.mcp(request) ?? mcpUnavailable();
};
export const GET=handle;
export const POST=handle;
export const DELETE=handle;
