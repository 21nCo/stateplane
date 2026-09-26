import type { ActorContext, Capability, CollectionId, SpaceId } from '@stateplane/contracts';
export interface Authorizer { require(actor: ActorContext, spaceId: SpaceId, collectionId: CollectionId, capability: Capability): Promise<void>; }
export interface UnitOfWork { transaction<T>(operation: () => Promise<T>): Promise<T>; }
export interface ApplicationPorts { authorizer: Authorizer; unitOfWork: UnitOfWork; }
/** Bind the scaffold application to its supplied service ports. */
export function createApplication(ports: ApplicationPorts): ApplicationPorts { return ports; }
