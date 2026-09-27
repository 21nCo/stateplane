import type { ApplicationPorts } from '@stateplane/application';
import type { RecordRef, Revision } from '@stateplane/contracts';
export interface ProjectionJob { ref: RecordRef; revision: Revision; generation: number; }
export interface ProjectionWorker { run(job: ProjectionJob, services: ApplicationPorts): Promise<void>; }
