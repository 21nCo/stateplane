import type { SpaceId } from '@stateplane/contracts';
export interface OriginalObjectStore { put(spaceId: SpaceId, digest: string, bytes: Uint8Array): Promise<void>; get(spaceId: SpaceId, digest: string): Promise<Uint8Array | null>; delete(spaceId: SpaceId, digest: string): Promise<void>; }
