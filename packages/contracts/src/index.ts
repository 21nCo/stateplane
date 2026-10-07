export type SpaceId = string & { readonly __spaceId: unique symbol };
export type CollectionId = string & { readonly __collectionId: unique symbol };
export type Revision = number & { readonly __revision: unique symbol };
const isSafeInteger = Number.isSafeInteger;
/** Validate a revision before it crosses an authority or worker boundary. */
export function parseRevision(value: unknown): Revision {
  if (typeof value !== 'number' || !isSafeInteger(value) || value < 1) {
    throw new RangeError('Revision must be a positive safe integer');
  }
  return value as Revision;
}
export interface RecordRef { spaceId: SpaceId; collectionId: CollectionId; id: string; }
export type Capability = 'schema:write' | 'records:read' | 'records:write' | 'sources:read' | 'sources:write' | 'claims:read' | 'claims:write' | 'claims:review' | 'events:read' | 'export:read' | 'space:admin';
export interface ActorContext { principalId: string; credentialId: string; }
/** AuthFn proves the credential; Stateplane assigns the principal for agent keys. */
export type VerifiedCredential =
  | { credentialId: string; kind: 'session'; userPrincipalId: string }
  | { credentialId: string; kind: 'api-key'; userPrincipalId?: never };
export interface Placement { cellId: string; storageTargetId: string; generation: number; }
export interface ProjectionStatus { state: 'pending' | 'current' | 'degraded'; generation: number; }

/** Decode the path once for HTTP dispatch and client retry decisions. */
export function parseV1Path(pathname:string):string[]|null {
  const parts=pathname.split('/').slice(1);
  if (parts[0]!=='v1') return null;
  const decoded:string[]=[];
  for (const part of parts.slice(1)) {
    try {
      // Preserve the router's escaped spelling for literal dot identifiers.
      if (part===';.' || part===';..') { decoded.push(part.slice(1)); continue; }
      const value=decodeURIComponent(part);
      if (!value || value==='.' || value==='..' || value.includes('\0') || value.length>512) return null;
      decoded.push(value);
    } catch { return null; }
  }
  return decoded;
}

/** Only exact queries and counts are safe POST operations to repeat. */
export function isSafeHttpRead(method:string,route:readonly string[]):boolean {
  if (method==='GET') return true;
  return method==='POST' && route.length===6 && route[0]==='spaces' &&
    route[2]==='collections' && route[4]==='records' &&
    (route[5]==='query' || route[5]==='count');
}
