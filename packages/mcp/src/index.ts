import type { ApplicationPorts } from '@stateplane/application';
import type { IdentityVerifier } from '@stateplane/auth';
export interface McpDependencies { services: ApplicationPorts; identity: IdentityVerifier; }
