export type SpaceId = string & { readonly __spaceId: unique symbol };
export type CollectionId = string & { readonly __collectionId: unique symbol };
export type Revision = number;
export interface RecordRef { spaceId: SpaceId; collectionId: CollectionId; id: string; }
export type Capability = 'schema:write' | 'records:read' | 'records:write' | 'sources:read' | 'sources:write' | 'claims:read' | 'claims:write' | 'claims:review' | 'events:read' | 'export:read' | 'space:admin';
export interface ActorContext { principalId: string; credentialId: string; }
export interface Placement { cellId: string; storageTargetId: string; generation: number; }
export interface ProjectionStatus { state: 'pending' | 'current' | 'degraded'; generation: number; }
