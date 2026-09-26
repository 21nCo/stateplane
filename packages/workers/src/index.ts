import type { ApplicationPorts } from '@stateplane/application';
export interface ProjectionJob { spaceId: string; refId: string; revision: number; generation: number; }
export interface ProjectionWorker { run(job: ProjectionJob, services: ApplicationPorts): Promise<void>; }
