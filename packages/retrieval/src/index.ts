import type { RecordRef } from '@stateplane/contracts';
export interface Candidate { ref: RecordRef; revision: number; score: number; }
export interface CandidateIndex { search(spaceId: string, query: string, limit: number): Promise<Candidate[]>; }
export interface Embedder { embed(text: string): Promise<{ model: string; version: string; values: number[] }>; }
