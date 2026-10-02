import type { Capability, VerifiedCredential } from '@stateplane/contracts';

export class RoutingDenied extends Error {
  constructor(public readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'SPACE_UNAVAILABLE' | 'STALE_PLACEMENT') {
    super(code); this.name = 'RoutingDenied';
  }
}

export interface RouteClaims {
  spaceId: string; collectionId: string; capability: Capability;
  credentialId: string; kind: VerifiedCredential['kind']; userPrincipalId?: string;
  cellId: string; policyVersion: number; placementGeneration: number;
  audience: string; issuedAt: number; expiresAt: number; nonce: string;
}
export interface DirectoryPlacement {
  spaceId: string; cellId: string; lifecycle: string; policyVersion: number; placementGeneration: number;
}
export interface RoutingDirectory {
  lookup(spaceId: string): Promise<DirectoryPlacement | null>;
  authorized(actor: VerifiedCredential, spaceId: string, collectionId: string, capability: Capability): Promise<boolean>;
}
export interface RouteIdentity { verify(request: Request): Promise<VerifiedCredential | null>; }

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new RoutingDenied('FORBIDDEN');
  try { return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/') + '='.repeat((4-value.length%4)%4)), c => c.charCodeAt(0)); }
  catch { throw new RoutingDenied('FORBIDDEN'); }
}
const bytes = (value: string) => new TextEncoder().encode(value);
function cryptoBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const capabilitySet = new Set<Capability>(['schema:write','records:read','records:write','sources:read','sources:write','claims:read','claims:write','claims:review','events:read','export:read','space:admin']);

/** HMAC keyring. Only the active key signs; retained keys verify until removed. */
export class RoutingKeys {
  private readonly keys = new Map<string, Promise<CryptoKey>>();
  constructor(entries: ReadonlyArray<{ id: string; secret: Uint8Array }>, readonly activeId: string) {
    for (const entry of entries) {
      if (!string(entry.id) || entry.secret.byteLength < 32 || this.keys.has(entry.id)) throw new Error('Invalid routing keyring');
      this.keys.set(entry.id, crypto.subtle.importKey('raw', cryptoBytes(entry.secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign','verify']));
    }
    if (!this.keys.has(activeId)) throw new Error('Missing active routing key');
  }
  async sign(claims: RouteClaims): Promise<string> {
    const body = encode(bytes(JSON.stringify(claims)));
    const header = encode(bytes(JSON.stringify({ alg:'HS256', kid:this.activeId })));
    const input = `${header}.${body}`;
    return `${input}.${encode(new Uint8Array(await crypto.subtle.sign('HMAC', await this.keys.get(this.activeId)!, bytes(input))))}`;
  }
  async verify(token: string, cellId: string, now: number): Promise<RouteClaims> {
    if (typeof token !== 'string' || token.length > 4096) throw new RoutingDenied('FORBIDDEN');
    const parts = token.split('.');
    if (parts.length !== 3) throw new RoutingDenied('FORBIDDEN');
    let header: { alg?: unknown; kid?: unknown };
    try { header = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(parts[0]))); }
    catch { throw new RoutingDenied('FORBIDDEN'); }
    if (header?.alg !== 'HS256' || !string(header.kid)) throw new RoutingDenied('FORBIDDEN');
    const key = this.keys.get(header.kid);
    if (!key || !await crypto.subtle.verify('HMAC', await key, cryptoBytes(decode(parts[2])), bytes(`${parts[0]}.${parts[1]}`))) throw new RoutingDenied('FORBIDDEN');
    let value: RouteClaims;
    try { value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(parts[1]))); }
    catch { throw new RoutingDenied('FORBIDDEN'); }
    if (!value || !string(value.spaceId) || !string(value.collectionId) || !capabilitySet.has(value.capability) ||
      !string(value.credentialId) || !['session','api-key'].includes(value.kind) ||
      (value.kind === 'session' ? !string(value.userPrincipalId) : value.userPrincipalId !== undefined) ||
      !string(value.cellId) || value.cellId !== cellId || value.audience !== `stateplane-cell:${cellId}` ||
      !version(value.policyVersion) || !version(value.placementGeneration) || !string(value.nonce) ||
      !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
      value.issuedAt > now || value.expiresAt <= now || value.expiresAt - value.issuedAt > 60) throw new RoutingDenied('FORBIDDEN');
    return Object.freeze(value);
  }
}

/** The selector only chooses a directory row. No client-provided cell or principal is trusted. */
export class RegionalRouter {
  constructor(private readonly identity: RouteIdentity, private readonly directory: RoutingDirectory,
    private readonly keys: RoutingKeys, private readonly clock: () => number = () => Math.floor(Date.now()/1000)) {}
  async assertion(request: Request, spaceId: string, collectionId: string, capability: Capability): Promise<{ cellId: string; token: string }> {
    if (!string(spaceId) || !string(collectionId) || !capabilitySet.has(capability)) throw new RoutingDenied('NOT_FOUND');
    const actor = await this.identity.verify(request);
    if (!actor) throw new RoutingDenied('UNAUTHENTICATED');
    const placement = await this.directory.lookup(spaceId);
    if (!placement || placement.lifecycle === 'deleted') throw new RoutingDenied('NOT_FOUND');
    if (!await this.directory.authorized(actor,spaceId,collectionId,capability)) throw new RoutingDenied('NOT_FOUND');
    if (placement.lifecycle !== 'active' && placement.lifecycle !== 'readOnly') throw new RoutingDenied('SPACE_UNAVAILABLE');
    const issuedAt = this.clock();
    const claims: RouteClaims = { spaceId,collectionId,capability,credentialId:actor.credentialId,kind:actor.kind,
      ...(actor.kind === 'session' ? { userPrincipalId:actor.userPrincipalId } : {}),
      cellId:placement.cellId,policyVersion:placement.policyVersion,placementGeneration:placement.placementGeneration,
      audience:`stateplane-cell:${placement.cellId}`,issuedAt,expiresAt:issuedAt+30,nonce:crypto.randomUUID() };
    return { cellId:placement.cellId, token:await this.keys.sign(claims) };
  }
}

export interface CellPolicy<Context> {
  /** Durably consumes the nonce before running the effect under current policy/placement locks. */
  run<T>(claims: RouteClaims, effect: (principalId: string, context: Context) => Promise<T>): Promise<T>;
}
/** Direct callers without a gateway assertion cannot enter an effect boundary. */
export class RegionalCell<Context> {
  constructor(private readonly cellId: string, private readonly keys: RoutingKeys, private readonly policy: CellPolicy<Context>,
    private readonly clock: () => number = () => Math.floor(Date.now()/1000)) {}
  async execute<T>(token: string, effect: (principalId: string, context: Context, claims: RouteClaims) => Promise<T>): Promise<T> {
    const claims = await this.keys.verify(token,this.cellId,this.clock());
    return this.policy.run(claims,(principalId,context) => effect(principalId,context,claims));
  }
}
