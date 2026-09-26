export type SpaceId = string & { readonly __spaceId: unique symbol };
export type CollectionId = string & { readonly __collectionId: unique symbol };
export type Revision = number & { readonly __revision: unique symbol };
export function parseRevision(value: unknown): Revision {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('Revision must be a positive safe integer');
  }
  return value as Revision;
}
export interface RecordRef { spaceId: SpaceId; collectionId: CollectionId; id: string; }
export type Capability = 'schema:write' | 'records:read' | 'records:write' | 'sources:read' | 'sources:write' | 'claims:read' | 'claims:write' | 'claims:review' | 'events:read' | 'export:read' | 'space:admin';
export interface ActorContext { principalId: string; credentialId: string; }
export interface Placement { cellId: string; storageTargetId: string; generation: number; }
export interface ProjectionStatus { state: 'pending' | 'current' | 'degraded'; generation: number; }
