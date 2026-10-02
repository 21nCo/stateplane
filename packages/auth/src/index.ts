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
  /** Re-read the provider at cell admission; a signed assertion is not proof of current status. */
  async current(claims: Pick<VerifiedCredential, 'kind' | 'credentialId'>, ownerPrincipalId: string): Promise<boolean> {
    const record = await this.config.database.findOne<{
      id: string; userId: string; revokedAt?: Date | null; expiresAt?: Date | null;
    }>({ model:claims.kind === 'api-key' ? 'api_keys' : 'sessions',
      where:[{field:'id',operator:'eq',value:claims.credentialId}],namespace:this.config.namespace ?? 'authfn' });
    return !!record && record.userId === ownerPrincipalId && !record.revokedAt &&
      (record.expiresAt == null || new Date(record.expiresAt).getTime() > Date.now());
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
