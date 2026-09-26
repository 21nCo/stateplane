import type { RecordRef } from '@stateplane/contracts';
export interface StateplaneClient { get(ref: RecordRef): Promise<unknown>; }
