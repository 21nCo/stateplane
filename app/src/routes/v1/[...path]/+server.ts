import { stateplaneHost, unavailable } from '$lib/server/host';
import type { Bindings } from '$lib/server/host';
import type { RequestHandler } from './$types';

const handle:RequestHandler=({request,platform})=>{
  const env={...process.env,...platform?.env} as unknown as Bindings;
  return stateplaneHost(env)?.http(request) ?? unavailable();
};
export const GET=handle;
export const POST=handle;
export const PUT=handle;
export const PATCH=handle;
export const DELETE=handle;
