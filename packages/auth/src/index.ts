import type { ActorContext } from '@stateplane/contracts';
export interface IdentityVerifier { verify(request: Request): Promise<ActorContext | null>; }
export interface CredentialRevoker { revoke(credentialId: string): Promise<void>; }
