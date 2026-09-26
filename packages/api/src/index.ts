import type { ApplicationPorts } from '@stateplane/application';
import type { IdentityVerifier } from '@stateplane/auth';
export interface HttpDependencies { services: ApplicationPorts; identity: IdentityVerifier; }
/** Expose scaffold status to HTTP consumers. */
export function healthResponse(): Response { return Response.json({ service: 'stateplane', status: 'scaffold' }); }
