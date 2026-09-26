import type { ApplicationPorts } from '@stateplane/application';
import type { IdentityVerifier } from '@stateplane/auth';
export interface HttpDependencies { services: ApplicationPorts; identity: IdentityVerifier; }
export function healthResponse(): Response { return Response.json({ service: 'stateplane', status: 'scaffold' }); }
