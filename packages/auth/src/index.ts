import { AuthFnApiKeyRevokedError, assertValidCsrf, authenticateApiKey, authenticateSessionToken, createApiKey,
  getCookieSessionState, revokeApiKeyById } from '@authfn/core';
import type { AuthFnConfig } from '@authfn/core';
import type { VerifiedCredential } from '@stateplane/contracts';

export interface IdentityVerifier { verify(request: Request): Promise<VerifiedCredential | null>; }
/** A bearer is either an AuthFn session or API key. Do not infer a key's Stateplane principal from AuthFn's owner metadata. */
export class AuthFnIdentityVerifier implements IdentityVerifier {
  constructor(private readonly config: AuthFnConfig) {}
  async verify(request: Request): Promise<VerifiedCredential | null> {
    const header = request.headers.get('authorization');
    if (!header) {
      const state = await getCookieSessionState(this.config, request);
      if (!state.session || state.session.type !== 'session' || !state.session.actorId) return null;
      if (!['GET','HEAD','OPTIONS'].includes(request.method)) assertValidCsrf(request,state);
      return { credentialId:state.session.id,kind:'session',userPrincipalId:state.session.actorId };
    }
    if (!/^Bearer [^\s]+$/.test(header)) return null;
    const secret = header.slice(7);
    // API-key revocation raises a provider error. Authentication failure is a denial,
    // while an unavailable adapter must fail closed and must not reach Stateplane effects.
    const key = await authenticateApiKey(this.config, secret).catch(error => {
      if (error instanceof AuthFnApiKeyRevokedError) return null;
      throw error;
    });
    if (key) return { credentialId:key.id, kind:'api-key' };
    const session = await authenticateSessionToken(this.config, secret, request);
    if (!session || session.type !== 'session' || !session.actorId) return null;
    return { credentialId:session.id, kind:'session', userPrincipalId:session.actorId };
  }
}

/** The AuthFn key is created first; Stateplane grants it only after cell authority commits. */
export class AuthFnAgentKeys {
  constructor(private readonly config: AuthFnConfig) {}
  async create(ownerPrincipalId: string, expiresAt: Date): Promise<{ id: string; secret: string }> {
    const key = await createApiKey(this.config,{ userId:ownerPrincipalId,name:'Stateplane agent',expiresAt });
    return { id:key.keyId,secret:key.secret };
  }
  async revoke(id: string, ownerPrincipalId: string): Promise<void> {
    await revokeApiKeyById(this.config,id,{ userId:ownerPrincipalId });
  }
}
