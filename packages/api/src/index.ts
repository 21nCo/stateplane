import type { StateplaneServices } from '@stateplane/application';
import type { IdentityVerifier } from '@stateplane/auth';
export interface HttpDependencies { services: StateplaneServices; identity: IdentityVerifier; }
/** Expose scaffold status to HTTP consumers. */
export function healthResponse(): Response { return Response.json({ service: 'stateplane', status: 'scaffold' }); }
export { createHttpHandler } from './http.js';
