import { createHash } from 'node:crypto';
import type pg from 'pg';
import { CHUNK_CODE_POINTS, configuredChunks, EMBED_RETRY_DELAYS_MS, embedBatch, EmbedderUnavailableError, EmbeddingRegistry,
  PROJECTION_INCOMPLETE, ProjectionIncompleteError } from '@stateplane/retrieval';
import type { ContentPolicy, Embedder, EmbedderIdentity, TextChunk } from '@stateplane/retrieval';
import { CommitOutcomeUnknownError } from './index.js';
import type { ProjectionChange, ProjectionQuery } from './index.js';
import { bounded, diagnostic, inTransaction, infrastructureFault, text } from './faults.js';
import type { PoolLike } from './faults.js';
import { FAILED_OUTBOX, LIVE_OUTBOX } from './outbox-sql.js';
import type { Projector } from './outbox.js';
import { lockKey } from './sources.js';

type RefKind = 'record' | 'source' | 'claim';
type Query = (sql: string, values?: unknown[]) => Promise<pg.QueryResult>;

/** The authoritative state one Ref is projected to: a revision (and extraction) with its content, or its deletion. */
interface Target {
  spaceId: string; collectionId: string; kind: RefKind; id: string;
  revision: number; extractionVersion: number | null; deleted: boolean; content: string | null;
}
/** A generation that is not retired, with the content its own policy configures and the regions both policies allow. */
interface Generation {
  generation: number; state: 'building' | 'verifying' | 'active'; policyVersion: number; lexical: boolean; vector: boolean; policy: ContentPolicy;
  identity: EmbedderIdentity | null; regions: string[];
}
interface Chunk extends TextChunk { index: number; sha256: string }

// Initial protective bounds, not measured provider capacity. Preparing one
// Ref stops starting embedding batches after 15 s and ends by 16 s, well
// inside the record outbox's 30 s processing budget; a retrieval item's lease
// outlasts its whole budget. A lock wait gives way after 1 s and is retried.
const PREPARE_MS = 15_000;
const ITEM_MS = 20_000;
// An item is started only with at least this much of the step left; otherwise it waits for the next step.
const MIN_ITEM_MS = 1_000;
const LEASE_MS = 60_000;
const LOCK_MS = 1_000;
// Time an interrupted preparation gets to save the batch it already has. An
// evidence item's preparation gets at most half its budget and this grace at
// most a quarter, so both end before the item's own budget does.
const GRACE_MS = 1_000;
// Backoff from 5 s doubling: an outage or an interrupted item retries within
// 5 minutes, an item's own failure within an hour. Retrieval work has no
// dead letter; a failing item stays pending and is reported as degraded.
const OUTAGE_BACKOFF_CAP_S = 300;
const FAILURE_BACKOFF_CAP_S = 3_600;
// Status reads at most this many rows per queue.
const STATUS_SAMPLE = 500;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const vectorText = (values: readonly number[]) => `[${values.join(',')}]`;
const refKey = (target: Target, generation: number) => [target.spaceId, target.collectionId, generation, target.kind, target.id];
const REF = 'space_id=$1 AND collection_id=$2 AND generation=$3 AND ref_kind=$4 AND ref_id=$5';

/**
 * The collection's generations that are not retired, oldest first. Each is
 * projected under its own (immutable) policy, and embedding is allowed only in
 * regions both its policy and the collection's current policy list, in the
 * current policy's order.
 */
async function loadGenerations(query: Query, spaceId: string, collectionId: string): Promise<Generation[]> {
  const rows = (await query(`SELECT g.generation,g.state,g.policy_version,g.embedder,g.embedding_model,g.model_version,g.dimensions,
      p.record_fields,p.source_content,p.claim_statements,p.lexical,p.vector,
      ARRAY(SELECT r FROM unnest(c.processing_regions) WITH ORDINALITY u(r,n)
        WHERE r=ANY(p.processing_regions) ORDER BY n) AS regions
    FROM projection_generations g
    JOIN retrieval_policies p ON p.space_id=g.space_id AND p.collection_id=g.collection_id AND p.version=g.policy_version
    JOIN retrieval_collection_heads h ON h.space_id=g.space_id AND h.collection_id=g.collection_id
    JOIN retrieval_policies c ON c.space_id=h.space_id AND c.collection_id=h.collection_id AND c.version=h.policy_version
    WHERE g.space_id=$1 AND g.collection_id=$2 AND g.state<>'retired' ORDER BY g.generation`, [spaceId, collectionId])).rows;
  return rows.map(row => ({ generation: Number(row.generation), state: row.state, policyVersion: Number(row.policy_version),
    lexical: row.lexical, vector: row.vector, regions: row.regions,
    policy: { recordFields: row.record_fields, sourceContent: row.source_content, claimStatements: row.claim_statements },
    identity: row.embedder === null ? null : { embedder: row.embedder, model: row.embedding_model,
      modelVersion: row.model_version, dimensions: Number(row.dimensions) } }));
}

/** The configured chunks of a live target under one generation's policy; nothing else is ever indexed or embedded. */
function chunksFor(generation: Generation, target: Target): Chunk[] {
  if (target.deleted || target.content === null) return [];
  return configuredChunks(target.kind, generation.policy, target.content)
    .map((chunk, index) => ({ ...chunk, index, sha256: sha256(chunk.content) }));
}

/** Whether a generation's policy configures any content of this kind of Ref; if not, it never projects one. */
function configures(generation: Generation, kind: RefKind): boolean {
  if (kind === 'record') return generation.policy.recordFields.length > 0;
  return kind === 'source' ? generation.policy.sourceContent : generation.policy.claimStatements;
}

/** Compare a projected Ref's position with a live target: revision, then extraction version. */
function compare(row: { revision: string | number; extraction_version: string | number | null }, target: Target): number {
  return Math.sign(Number(row.revision) - target.revision)
    || Math.sign(Number(row.extraction_version ?? 0) - (target.extractionVersion ?? 0));
}

/** Share lock a generation that is not retired, so retiring it waits for this writer. */
async function lockGeneration(query: Query, target: Target, generation: number): Promise<boolean> {
  const row = (await query(`SELECT state FROM projection_generations WHERE space_id=$1 AND collection_id=$2 AND generation=$3
    FOR SHARE`, [target.spaceId, target.collectionId, generation])).rows[0];
  return row !== undefined && row.state !== 'retired';
}

async function refRow(query: Query, target: Target, generation: number, lock: 'SHARE' | 'UPDATE') {
  return (await query(`SELECT revision,extraction_version,deleted FROM projection_refs WHERE ${REF} FOR ${lock}`,
    refKey(target, generation))).rows[0] as { revision: string; extraction_version: string | null; deleted: boolean } | undefined;
}

/** Whether a Ref at the target already holds every chunk its generation's projections need. */
async function complete(query: Query, target: Target, generation: Generation, chunks: number): Promise<boolean> {
  const row = (await query(`SELECT (SELECT count(*) FROM lexical_chunks WHERE ${REF})::int AS lexical,
    (SELECT count(*) FROM vector_chunks WHERE ${REF})::int AS vector`, refKey(target, generation.generation))).rows[0];
  return row.lexical === (generation.lexical ? chunks : 0) && row.vector === (generation.vector ? chunks : 0);
}

interface Saved { index: number; sha256: string; region: string; embedding: string }

/**
 * Record a live Ref in a vector generation (at its target revision when the
 * generation has never projected it), so checkpoints can reference it, then
 * report which chunks still need an embedding. Embeddings of the same text
 * already in this generation, from earlier revisions or checkpoints, are
 * reused. Returns null when the generation has deleted the Ref, holds a newer
 * revision, or already holds this one completely.
 */
async function planEmbeddings(query: Query, target: Target, generation: Generation, chunks: Chunk[])
  : Promise<{ missing: Chunk[]; reused: Saved[] } | null> {
  if (!await lockGeneration(query, target, generation.generation)) return null;
  const key = refKey(target, generation.generation);
  let row = await refRow(query, target, generation.generation, 'SHARE');
  if (!row) {
    await query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision,extraction_version)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [...key, target.revision, target.extractionVersion]);
    row = await refRow(query, target, generation.generation, 'SHARE');
  }
  if (!row || row.deleted || compare(row, target) > 0) return null;
  if (compare(row, target) === 0 && await complete(query, target, generation, chunks.length)) return null;
  // A checkpoint from a region either policy no longer allows is never applied.
  await query(`DELETE FROM embedding_checkpoints WHERE ${REF} AND processing_region<>ALL($6::text[])`, [...key, generation.regions]);
  const saved = new Set((await query(`SELECT chunk_index,content_sha256 FROM embedding_checkpoints WHERE ${REF}
      AND revision=$6 AND COALESCE(extraction_version,0)=$7`, [...key, target.revision, target.extractionVersion ?? 0]))
    .rows.map(found => `${found.chunk_index}:${found.content_sha256}`));
  const needed = chunks.filter(chunk => !saved.has(`${chunk.index}:${chunk.sha256}`));
  if (!needed.length) return { missing: [], reused: [] };
  const known = new Map<string, { region: string; embedding: string }>();
  for (const found of (await query(`SELECT content_sha256,processing_region,embedding::text AS embedding FROM vector_chunks
      WHERE ${REF} AND content_sha256=ANY($6::text[]) AND processing_region=ANY($7::text[])
    UNION ALL SELECT content_sha256,processing_region,embedding::text FROM embedding_checkpoints
      WHERE ${REF} AND content_sha256=ANY($6::text[]) AND processing_region=ANY($7::text[])`,
  [...key, [...new Set(needed.map(chunk => chunk.sha256))], generation.regions])).rows)
    known.set(found.content_sha256, { region: found.processing_region, embedding: found.embedding });
  const reused = needed.flatMap(chunk => {
    const found = known.get(chunk.sha256);
    return found ? [{ index: chunk.index, sha256: chunk.sha256, ...found }] : [];
  });
  return { missing: needed.filter(chunk => !known.has(chunk.sha256)), reused };
}

/**
 * Save embeddings computed outside SQL. False, saving nothing, when the
 * generation is retired, has deleted the Ref, has moved it past this target
 * or already holds this target completely: a late preparation never leaves
 * checkpoints that no later apply of the Ref would remove.
 */
async function saveCheckpoints(query: Query, target: Target, generation: Generation, chunks: number, saved: Saved[])
  : Promise<boolean> {
  const identity = generation.identity!;
  if (!await lockGeneration(query, target, generation.generation)) return false;
  // Share locked: an apply of the Ref waits for this save, or this save sees the apply.
  const row = await refRow(query, target, generation.generation, 'SHARE');
  if (!row || row.deleted || compare(row, target) > 0
    || compare(row, target) === 0 && await complete(query, target, generation, chunks)) return false;
  try {
    await query(`INSERT INTO embedding_checkpoints(space_id,collection_id,generation,ref_kind,ref_id,revision,extraction_version,
        chunk_index,content_sha256,embedder,embedding_model,model_version,dimensions,processing_region,embedding)
      SELECT $1::text,$2::text,$3::bigint,$4::text,$5::text,$6::bigint,$7::bigint,c.i,c.sha,$8::text,$9::text,$10::text,
        $11::integer,c.region,c.embedding::vector
      FROM unnest($12::integer[],$13::text[],$14::text[],$15::text[]) AS c(i,sha,region,embedding)
      ON CONFLICT DO NOTHING`, [...refKey(target, generation.generation), target.revision, target.extractionVersion,
      identity.embedder, identity.model, identity.modelVersion, identity.dimensions, saved.map(entry => entry.index),
      saved.map(entry => entry.sha256), saved.map(entry => entry.region), saved.map(entry => entry.embedding)]);
    return true;
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (code === '23503' && constraint === 'embedding_checkpoints_live_ref') return false;
    // A narrower policy committed while the call was in flight: its result is refused, and the work runs again under it.
    if (code === '23514' && constraint === 'embedding_checkpoints_region')
      throw new ProjectionIncompleteError('The processing policy changed during preparation');
    throw error;
  }
}

/** Embedders that failed during one step; later items skip them until the next step. */
type Outages = Set<Embedder>;

/**
 * Prepare a live target outside any transaction: for each vector generation,
 * embed its missing chunks in the first allowed region that has its embedder,
 * batch by batch, saving each batch as checkpoints in its own short
 * transaction. No connection is held while the embedder runs. A generation
 * that cannot be prepared does not stop the others; after trying them all,
 * the first error that is the target's own is thrown, else the first outage.
 */
async function prepareTarget(pool: PoolLike, registry: EmbeddingRegistry, target: Target, signal: AbortSignal,
  progress: { saved: number }, outages?: Outages): Promise<void> {
  if (target.deleted) return;
  const errors: unknown[] = [];
  for (const generation of await inTransaction(pool, db => loadGenerations(db.query.bind(db), target.spaceId, target.collectionId))) {
    if (!generation.vector || !generation.identity) continue;
    try { await prepareGeneration(pool, registry, target, generation, signal, progress, outages); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors.find(error => !infrastructureFault(error)) ?? errors[0];
}

async function prepareGeneration(pool: PoolLike, registry: EmbeddingRegistry, target: Target, generation: Generation,
  signal: AbortSignal, progress: { saved: number }, outages?: Outages): Promise<void> {
  const chunks = chunksFor(generation, target);
  if (!chunks.length) return;
  const embedder = registry.resolve(generation.identity!, generation.regions, CHUNK_CODE_POINTS);
  if (!embedder) throw new EmbedderUnavailableError(`No configured embedder for generation ${generation.generation} in a region its policies allow`);
  if (outages?.has(embedder)) throw new EmbedderUnavailableError('Embedder unavailable earlier in this step');
  const plan = await inTransaction(pool, db => planEmbeddings(db.query.bind(db), target, generation, chunks));
  if (!plan) return;
  const save = (saved: Saved[]) => inTransaction(pool, db => saveCheckpoints(db.query.bind(db), target, generation,
    chunks.length, saved));
  if (plan.reused.length && !await save(plan.reused)) return;
  // Before every provider call, a retry included, the generation must be
  // live and both its policy and the collection's current one must still
  // allow the embedder's region; a narrower policy committed since stops the
  // generation's preparation before any more content leaves.
  const admit = async () => {
    const current = (await inTransaction(pool, db => loadGenerations(db.query.bind(db), target.spaceId, target.collectionId)))
      .find(entry => entry.generation === generation.generation);
    if (!current?.regions.includes(embedder.profile.region))
      throw new ProjectionIncompleteError('The processing policy changed during preparation');
  };
  for (let start = 0; start < plan.missing.length; start += embedder.profile.maxBatch) {
    const batch = plan.missing.slice(start, start + embedder.profile.maxBatch);
    let vectors: number[][];
    try { vectors = await embedBatch(embedder, batch.map(chunk => chunk.content), signal, EMBED_RETRY_DELAYS_MS, admit); }
    catch (error) {
      // A call cut short by the budget says nothing about the provider.
      if (error instanceof EmbedderUnavailableError && !signal.aborted) outages?.add(embedder);
      throw error;
    }
    const saved = batch.map((chunk, index) => ({ index: chunk.index, sha256: chunk.sha256, region: embedder.profile.region,
      embedding: vectorText(vectors[index]) }));
    if (!await save(saved)) return;
    progress.saved += saved.length;
  }
}

/**
 * Run preparation within its own budget, before the caller's. When the
 * budget ends, preparation stops starting embedding calls and gets up to
 * `graceMs` to finish saving the batch it has, so a retry does not embed it
 * again. Preparation that saved checkpoints is then incomplete and resumes
 * from them; one that saved nothing is an outage. Either releases the work
 * without spending its failure budget. Preparation that finishes in the
 * grace period succeeds. The caller's budget ending first stops it at once
 * with the same outcome, so running out of time is never the work's failure.
 */
async function budgeted(run: (signal: AbortSignal, progress: { saved: number }) => Promise<void>, parent: AbortSignal,
  ms: number, graceMs = GRACE_MS): Promise<void> {
  const controller = new AbortController();
  const progress = { saved: 0 };
  const expired = () => progress.saved ? new ProjectionIncompleteError()
    : new EmbedderUnavailableError('Embedding exceeded its time budget');
  let grace: ReturnType<typeof setTimeout> | undefined;
  let stop: (error: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { stop = reject; });
  stopped.catch(() => {});
  const timer = setTimeout(() => {
    controller.abort(new EmbedderUnavailableError('Embedding budget ended'));
    grace = setTimeout(() => stop(expired()), graceMs);
  }, ms);
  const forward = () => { controller.abort(parent.reason); stop(expired()); };
  if (parent.aborted) forward();
  else parent.addEventListener('abort', forward, { once: true });
  try {
    const work = run(controller.signal, progress);
    work.catch(() => {});
    await Promise.race([work, stopped]);
  } catch (error) {
    // An embedder that gives up on the aborted signal reports the budget's own outcome.
    throw controller.signal.aborted ? expired() : error;
  } finally {
    clearTimeout(timer);
    clearTimeout(grace);
    parent.removeEventListener('abort', forward);
  }
}

/** Remove a Ref's checkpoints at or before a position its generation holds; a later apply never needs them. */
async function dropCheckpoints(query: Query, key: unknown[], revision: number | string, extraction: number | string | null) {
  await query(`DELETE FROM embedding_checkpoints WHERE ${REF}
    AND (revision,COALESCE(extraction_version,0))<=($6::bigint,COALESCE($7::bigint,0))`, [...key, revision, extraction]);
}

/**
 * Apply a target inside the caller's fenced transaction, to every generation
 * that is not retired, and return the generations it could not complete. A
 * Ref only moves forward: a generation that deleted it or holds a newer
 * revision is left alone, so a duplicate, reordered or late delivery changes
 * nothing but the removal of checkpoints the generation no longer needs. A
 * deletion removes the Ref's chunks and checkpoints, marks it deleted and
 * records a receipt. A live target replaces the Ref's chunks with the
 * configured chunks of its content; vector chunks come only from checkpoints
 * of exactly this text. A vector generation missing any of them is left
 * exactly as it was and returned, so one generation's outage never holds back
 * the others. A policy narrowing that commits after the regions were read is
 * caught by the storage trigger on insert and reported as `PROJECTION_INCOMPLETE`:
 * the whole apply rolls back and runs again, uncounted.
 */
async function applyTarget(query: Query, target: Target): Promise<number[]> {
  await query(`SET LOCAL lock_timeout = '${LOCK_MS}ms'`);
  const blocked: number[] = [];
  for (const generation of await loadGenerations(query, target.spaceId, target.collectionId)) {
    if (!configures(generation, target.kind) || !await lockGeneration(query, target, generation.generation)) continue;
    const key = refKey(target, generation.generation);
    const row = await refRow(query, target, generation.generation, 'UPDATE');
    if (row?.deleted) continue;
    if (target.deleted) {
      const lexical = await query(`DELETE FROM lexical_chunks WHERE ${REF}`, key);
      const vector = await query(`DELETE FROM vector_chunks WHERE ${REF}`, key);
      await query(`DELETE FROM embedding_checkpoints WHERE ${REF}`, key);
      if (row) await query(`UPDATE projection_refs SET revision=GREATEST(revision,$6),deleted=true,extraction_version=NULL
        WHERE ${REF}`, [...key, target.revision]);
      else await query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision,deleted)
        VALUES($1,$2,$3,$4,$5,$6,true)`, [...key, target.revision]);
      await query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,chunks_removed)
        SELECT space_id,collection_id,generation,ref_kind,ref_id,revision,$6::integer FROM projection_refs WHERE ${REF}`, [...key, (lexical.rowCount ?? 0) + (vector.rowCount ?? 0)]);
      continue;
    }
    const position = row ? compare(row, target) : -1;
    const chunks = chunksFor(generation, target);
    if (row && (position > 0 || position === 0 && await complete(query, target, generation, chunks.length))) {
      await dropCheckpoints(query, key, row.revision, row.extraction_version);
      continue;
    }
    // Nothing configured is present and nothing older was projected.
    if (!row && !chunks.length) continue;
    const columns = [chunks.map(chunk => chunk.index), chunks.map(chunk => chunk.field), chunks.map(chunk => chunk.start),
      chunks.map(chunk => chunk.end)];
    const checkpoints = `unnest($9::integer[],$10::text[],$11::bigint[],$12::bigint[],$13::text[]) AS c(i,field,s,e,sha)
        JOIN embedding_checkpoints k ON k.space_id=$1 AND k.collection_id=$2 AND k.generation=$3 AND k.ref_kind=$4
          AND k.ref_id=$5 AND k.revision=$6 AND COALESCE(k.extraction_version,0)=COALESCE($7::bigint,0)
          AND k.chunk_index=c.i AND k.content_sha256=c.sha AND k.processing_region=ANY($14::text[])`;
    const vectorValues = [...key, target.revision, target.extractionVersion, generation.policyVersion, ...columns,
      chunks.map(chunk => chunk.sha256), generation.regions];
    if (chunks.length && generation.vector) {
      // The same parameters as the insert below; $8 is typed though only the insert uses it.
      const ready = (await query(`SELECT count(*)::int AS n FROM ${checkpoints} WHERE $8::bigint > 0`, vectorValues)).rows[0].n;
      if (ready !== chunks.length) { blocked.push(generation.generation); continue; }
    }
    await query(`DELETE FROM lexical_chunks WHERE ${REF}`, key);
    await query(`DELETE FROM vector_chunks WHERE ${REF}`, key);
    if (!row) await query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision,extraction_version)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [...key, target.revision, target.extractionVersion]);
    else if (position < 0) await query(`UPDATE projection_refs SET revision=$6,extraction_version=$7 WHERE ${REF}`,
      [...key, target.revision, target.extractionVersion]);
    if (chunks.length && generation.lexical) await query(`INSERT INTO lexical_chunks(space_id,collection_id,generation,ref_kind,
        ref_id,revision,extraction_version,policy_version,chunk_index,field,content_start,content_end,content)
      SELECT $1::text,$2::text,$3::bigint,$4::text,$5::text,$6::bigint,$7::bigint,$8::bigint,c.i,c.field,c.s,c.e,c.content
      FROM unnest($9::integer[],$10::text[],$11::bigint[],$12::bigint[],$13::text[]) AS c(i,field,s,e,content)`,
    [...key, target.revision, target.extractionVersion, generation.policyVersion, ...columns, chunks.map(chunk => chunk.content)]);
    if (chunks.length && generation.vector) {
      const inserted = await query(`INSERT INTO vector_chunks(space_id,collection_id,generation,ref_kind,ref_id,revision,
          extraction_version,policy_version,embedder,embedding_model,model_version,dimensions,processing_region,chunk_index,
          field,content_start,content_end,content_sha256,embedding)
        SELECT k.space_id,k.collection_id,k.generation,k.ref_kind,k.ref_id,k.revision,k.extraction_version,$8::bigint,k.embedder,
          k.embedding_model,k.model_version,k.dimensions,k.processing_region,c.i,c.field,c.s,c.e,k.content_sha256,k.embedding
        FROM ${checkpoints}`, vectorValues).catch(error => {
        const { code, constraint } = error as { code?: string; constraint?: string };
        throw code === '23514' && constraint === 'vector_chunks_region'
          ? new ProjectionIncompleteError('The processing policy changed during apply') : error;
      });
      // Counted under the Ref's update lock just above; a difference is a bug, never an outage.
      if (inserted.rowCount !== chunks.length) throw new Error('Checkpoints changed under the Ref lock');
    }
    await dropCheckpoints(query, key, target.revision, target.extractionVersion);
  }
  return blocked;
}

/**
 * Lock a Ref's authoritative rows against its writers until commit, then
 * report whether authority still holds `target`. Taken last, just before
 * commit, so writers wait only for the commit, never for an apply or an
 * embedder; a change committed before the lock is seen by the reread, one
 * after it waits until this transaction ends. Record writes update the
 * record row; claim revisions and deletions update the claim's `entity_refs`
 * row; source extractions and deletions hold the source's extraction lock.
 */
async function authorityHolds(query: Query, target: Target): Promise<boolean> {
  const ids = [target.spaceId, target.collectionId, target.id];
  if (target.kind === 'record') {
    const row = (await query(`SELECT revision,tombstone FROM records WHERE space_id=$1 AND collection_id=$2 AND record_id=$3
      FOR SHARE`, ids)).rows[0];
    return row !== undefined && Number(row.revision) === target.revision && row.tombstone === target.deleted;
  }
  if (target.kind === 'source') await query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
    [lockKey(['stateplane:extraction', ...ids])]);
  if (!(await query(`SELECT 1 FROM entity_refs WHERE space_id=$1 AND collection_id=$2 AND kind=$3 AND entity_id=$4 FOR SHARE`,
    [target.spaceId, target.collectionId, target.kind, target.id])).rows[0]) return false;
  // A later statement, so it reads what the lock waited for.
  const now = await currentTarget(query, { spaceId: target.spaceId, collectionId: target.collectionId, kind: target.kind, id: target.id });
  return now.open && sameTarget(now.target, target);
}

export interface RetrievalOptions {
  /** Configured embedders; without one, vector generations stay pending and lexical ones still apply. */
  embedders?: EmbeddingRegistry;
  /** Budget, in ms, for preparing one Ref's embeddings: at most 15,000. */
  prepareMs?: number;
}

function options(value: RetrievalOptions) {
  const embedders = value.embedders ?? new EmbeddingRegistry();
  if (!(embedders instanceof EmbeddingRegistry)) throw new RangeError('Invalid embedder registry');
  return { embedders, prepareMs: bounded(value.prepareMs ?? PREPARE_MS, 1, PREPARE_MS) };
}

/**
 * Projects record revisions delivered by the record outbox. `prepare` embeds
 * outside SQL; `apply` runs in the outbox's fenced completion, which only
 * calls it for the record's latest committed revision, and ends by checking
 * that the record still holds it.
 *
 * When preparation fails for some generation (an outage, a missing embedder
 * or interrupted preparation), the generations that do not need it are
 * applied at once in a transaction of `prepare`'s own, fenced like
 * completion (open space and collection, current placement, the record still
 * at this revision), and `prepare` then throws: the delivery stays due, so
 * the record's projection head does not move until every generation has it.
 */
export class RecordRetrievalProjector implements Projector<void> {
  readonly #embedders: EmbeddingRegistry;
  readonly #prepareMs: number;
  constructor(private readonly pool: PoolLike, settings: RetrievalOptions = {}) {
    ({ embedders: this.#embedders, prepareMs: this.#prepareMs } = options(settings));
  }

  async prepare(change: ProjectionChange, signal: AbortSignal): Promise<void> {
    if (change.deleted) return;
    const target = recordTarget(change);
    try {
      await budgeted((budget, progress) => prepareTarget(this.pool, this.#embedders, target, budget, progress), signal, this.#prepareMs);
    } catch (error) {
      const blocked = await inTransaction(this.pool, db => this.applyAvailable(db.query.bind(db), target, change.generation))
        .catch(() => null);
      // Every generation turned out complete (an earlier attempt's checkpoints sufficed): completion applies.
      if (blocked?.length === 0) return;
      throw error;
    }
  }

  async apply(change: ProjectionChange, _prepared: void | undefined, query: ProjectionQuery): Promise<void> {
    const target = recordTarget(change);
    if ((await applyTarget(query, target)).length) throw new ProjectionIncompleteError('Embeddings are missing for this revision');
    if (!await authorityHolds(query, target)) throw new ProjectionIncompleteError('The record changed while it was projected');
  }

  /** Apply what is ready, under completion's scope fences; null when the scope no longer admits it. */
  private async applyAvailable(query: Query, target: Target, placement: number): Promise<number[] | null> {
    await query(`SET LOCAL lock_timeout = '${LOCK_MS}ms'`);
    const scope = (await query(`SELECT s.lifecycle IN ('active','readOnly') AND c.lifecycle<>'deleted'
        AND s.placement_generation=$3 AS open
      FROM spaces s JOIN collections c ON c.space_id=s.space_id AND c.collection_id=$2 WHERE s.space_id=$1 FOR KEY SHARE OF s`,
    [target.spaceId, target.collectionId, placement])).rows[0];
    if (!scope?.open) return null;
    const blocked = await applyTarget(query, target);
    if (!await authorityHolds(query, target)) throw new ProjectionIncompleteError('The record changed while it was projected');
    return blocked;
  }
}

function recordTarget(change: ProjectionChange): Target {
  return { spaceId: change.ref.spaceId, collectionId: change.ref.collectionId, kind: 'record', id: change.ref.id,
    revision: change.revision, extractionVersion: null, deleted: change.deleted, content: change.canonicalData };
}

export type RetrievalOutcome = 'applied' | 'released' | 'lost' | 'retried' | 'unknown';
export interface RetrievalStep { claimed: number; applied: number; released: number; lost: number; retried: number; unknown: number }
export interface RetrievalStepOptions {
  /** Wall-clock budget for the step, 1,000 to 60,000 ms. An item starts only with at least 1,000 ms left. */
  budgetMs?: number;
  /** Items per claim (at most 100) and per space/collection pair in one claim. */
  limit?: number; perPair?: number;
  /** Pairs one claim walks, at most 1,000. */
  pairs?: number;
}
/**
 * A leased item. `attempt` counts started attempts only; `lease` is the exact
 * `available_at` the lease set, so only its holder, while it lasts, can start,
 * complete or release the item.
 */
interface Job { jobId: string; spaceId: string; collectionId: string; kind: 'source' | 'claim'; id: string; attempt: number; lease: string }
type EvidenceRef = Pick<Job, 'spaceId' | 'collectionId' | 'kind' | 'id'>;

/** Read the current authoritative state of a source or claim and whether its space and collection are open. */
async function currentTarget(query: Query, job: EvidenceRef): Promise<{ open: boolean; target: Target | null }> {
  const row = (await query(`SELECT e.revision,e.tombstone,
      s.lifecycle IN ('active','readOnly') AND c.lifecycle<>'deleted' AS open,x.version,x.content,r.statement
    FROM entity_refs e JOIN spaces s ON s.space_id=e.space_id
    JOIN collections c ON c.space_id=e.space_id AND c.collection_id=e.collection_id
    LEFT JOIN LATERAL (SELECT v.version,v.content FROM extraction_versions v WHERE e.kind='source' AND NOT e.tombstone
      AND v.space_id=e.space_id AND v.collection_id=e.collection_id AND v.source_id=e.entity_id
      ORDER BY v.version DESC LIMIT 1) x ON true
    LEFT JOIN claim_revisions r ON e.kind='claim' AND NOT e.tombstone AND r.space_id=e.space_id
      AND r.collection_id=e.collection_id AND r.claim_id=e.entity_id AND r.revision=e.revision
    WHERE e.space_id=$1 AND e.collection_id=$2 AND e.kind=$3 AND e.entity_id=$4`,
  [job.spaceId, job.collectionId, job.kind, job.id])).rows[0];
  if (!row) return { open: false, target: null };
  const base = { spaceId: job.spaceId, collectionId: job.collectionId, kind: job.kind, id: job.id, revision: Number(row.revision) };
  if (row.tombstone) return { open: row.open, target: { ...base, extractionVersion: null, deleted: true, content: null } };
  const content = job.kind === 'source' ? row.content : row.statement;
  // A live source without an extraction has nothing to project yet; its first extraction enqueues work.
  if (content === null || content === undefined) return { open: row.open, target: null };
  return { open: row.open, target: { ...base, extractionVersion: job.kind === 'source' ? Number(row.version) : null,
    deleted: false, content } };
}

const sameTarget = (a: Target | null, b: Target | null) => a !== null && b !== null && a.revision === b.revision
  && a.extractionVersion === b.extractionVersion && a.deleted === b.deleted;

/** Authority changed between the reread and the commit fence; the apply rolls back and the item runs again. */
class AuthorityChanged extends Error {}

/**
 * How a failed attempt is retried: preparation stopped with its progress
 * saved runs again at once with no error; an outage, lock wait or lost
 * session after backoff from 5 s doubling to 5 minutes; anything else, the
 * item's own failure, after backoff to an hour. Only started attempts count.
 */
function retryOf(error: unknown, attempt: number): { delayMs: number; error: string | null } {
  if ((error as { code?: unknown })?.code === PROJECTION_INCOMPLETE) return { delayMs: 0, error: null };
  const cap = infrastructureFault(error) ? OUTAGE_BACKOFF_CAP_S : FAILURE_BACKOFF_CAP_S;
  return { delayMs: Math.min(cap, 5 * 2 ** Math.min(Math.max(attempt, 1) - 1, 10)) * 1_000, error: diagnostic(error) };
}

/**
 * Consumes `retrieval_outbox`: source extractions, claim revisions and
 * source or claim deletions. Each item projects its Ref's current
 * authoritative state, read fresh, so order and duplicates do not matter. A
 * claim leases an item by moving its due time past the lease; starting it
 * counts an attempt and renews the lease. Only that lease, while it lasts,
 * can start, complete or release the item.
 */
export class PostgresRetrievalWorker {
  readonly #embedders: EmbeddingRegistry;
  readonly #prepareMs: number;
  constructor(private readonly pool: PoolLike, settings: RetrievalOptions = {}) {
    ({ embedders: this.#embedders, prepareMs: this.#prepareMs } = options(settings));
  }

  /**
   * Claim and process due items until nothing is due or the budget is spent.
   * Each claim walks space/collection pairs after the previous claim's last
   * one, taking at most `perPair` items from each, so one backlog cannot
   * hold the step. Items the step has no time left to start are released due
   * at once, with no attempt spent, and the step ends. Only a failed claim
   * throws; each item settles itself.
   */
  async step(settings: RetrievalStepOptions = {}): Promise<RetrievalStep> {
    const budgetMs = bounded(settings.budgetMs ?? 10_000, MIN_ITEM_MS, 60_000);
    const limit = bounded(settings.limit ?? 8, 1, 100);
    const perPair = bounded(settings.perPair ?? 2, 1, limit);
    const pairs = bounded(settings.pairs ?? 100, 1, 1_000);
    const until = Date.now() + budgetMs;
    const result: RetrievalStep = { claimed: 0, applied: 0, released: 0, lost: 0, retried: 0, unknown: 0 };
    const outages: Outages = new Set();
    let after: [string, string] | null = null;
    // Whether the pass over the pair order that this claim continues has found work.
    let found = false;
    while (until - Date.now() >= MIN_ITEM_MS) {
      const claim = await this.claim(after, pairs, perPair, limit);
      result.claimed += claim.jobs.length;
      found ||= claim.jobs.length > 0;
      let next = 0;
      for (; next < claim.jobs.length && until - Date.now() >= MIN_ITEM_MS; next++)
        result[await this.process(claim.jobs[next], Math.min(ITEM_MS, until - Date.now()), outages)]++;
      if (next < claim.jobs.length) {
        const unstarted = claim.jobs.slice(next);
        await this.releaseUnstarted(unstarted).catch(() => {});
        result.released += unstarted.length;
        break;
      }
      after = claim.next;
      // A whole pass from the start of the pair order with nothing due ends the step.
      if (!after) { if (!found) break; found = false; }
    }
    return result;
  }

  private async claim(after: [string, string] | null, pairs: number, perPair: number, limit: number)
    : Promise<{ jobs: Job[]; next: [string, string] | null }> {
    return inTransaction(this.pool, async db => {
      const walked = (await db.query(`WITH RECURSIVE pairs(space_id,collection_id,n) AS (
          (SELECT space_id,collection_id,1 FROM retrieval_outbox WHERE delivery_state='pending'
            AND ($1::text IS NULL OR (space_id,collection_id)>($1,$2)) ORDER BY space_id,collection_id LIMIT 1)
          UNION ALL
          SELECT nx.space_id,nx.collection_id,p.n+1 FROM pairs p CROSS JOIN LATERAL (
            SELECT space_id,collection_id FROM retrieval_outbox WHERE delivery_state='pending'
              AND (space_id,collection_id)>(p.space_id,p.collection_id) ORDER BY space_id,collection_id LIMIT 1) nx
          WHERE p.n<$3)
        SELECT space_id,collection_id FROM pairs ORDER BY n`, [after?.[0] ?? null, after?.[1] ?? null, pairs])).rows;
      if (!walked.length) return { jobs: [], next: null };
      const claimed = await db.query(`WITH due AS (
          SELECT d.job_id FROM unnest($1::text[],$2::text[]) WITH ORDINALITY AS p(space_id,collection_id,n)
          JOIN spaces s ON s.space_id=p.space_id AND s.lifecycle IN ('active','readOnly')
          JOIN collections c ON c.space_id=p.space_id AND c.collection_id=p.collection_id AND c.lifecycle<>'deleted'
          CROSS JOIN LATERAL (SELECT job_id,available_at FROM retrieval_outbox WHERE space_id=p.space_id
            AND collection_id=p.collection_id AND delivery_state='pending' AND available_at<=clock_timestamp()
            ORDER BY available_at,job_id LIMIT $3 FOR UPDATE SKIP LOCKED) d
          ORDER BY p.n,d.available_at,d.job_id LIMIT $4)
        UPDATE retrieval_outbox o SET available_at=clock_timestamp()+($5::integer * interval '1 millisecond')
        FROM due WHERE o.job_id=due.job_id
        RETURNING o.job_id,o.space_id,o.collection_id,o.ref_kind,o.ref_id,o.attempts,o.available_at::text AS lease`,
      [walked.map(pair => pair.space_id), walked.map(pair => pair.collection_id), perPair, limit, LEASE_MS]);
      const last = walked.at(-1)!;
      return { next: walked.length === pairs ? [last.space_id, last.collection_id] : null,
        jobs: claimed.rows.map(row => ({ jobId: row.job_id, spaceId: row.space_id, collectionId: row.collection_id,
          kind: row.ref_kind, id: row.ref_id, attempt: row.attempts, lease: row.lease })) };
    });
  }

  /**
   * Process one leased item: start it (one more attempt, a renewed lease),
   * read its Ref's current state, prepare outside SQL, then apply under the
   * lease, the open space and the unchanged authoritative state, which is
   * locked against its writers for the commit. Generations that need what
   * preparation could not provide keep their previous state; the others
   * apply, and the item then stays pending with that failure's backoff. An
   * outage, a lock wait or interrupted preparation is never the item's own
   * error; any other error retries it with longer backoff and marks it
   * degraded. An unknown COMMIT outcome keeps the lease until it expires.
   */
  private async process(claimed: Job, budgetMs: number, outages: Outages): Promise<RetrievalOutcome> {
    const signal = AbortSignal.timeout(budgetMs);
    let job = claimed;
    try {
      const begun = await inTransaction(this.pool, async db => {
        const started = (await db.query(`UPDATE retrieval_outbox SET attempts=attempts+1,
            available_at=clock_timestamp()+($3::integer * interval '1 millisecond')
          WHERE job_id=$1 AND available_at=$2::timestamptz AND available_at>clock_timestamp() AND delivery_state='pending'
          RETURNING attempts,available_at::text AS lease`, [job.jobId, job.lease, LEASE_MS])).rows[0];
        if (!started) return null;
        job = { ...job, attempt: started.attempts, lease: started.lease };
        return currentTarget(db.query.bind(db), job);
      });
      if (!begun) return 'lost';
      const read = begun;
      if (!read.open) return await this.settle(job, 'release', null, 0);
      let failure: unknown = null;
      if (read.target && !read.target.deleted) {
        try {
          await budgeted((budget, progress) => prepareTarget(this.pool, this.#embedders, read.target!, budget, progress, outages),
            signal, Math.max(1, Math.min(this.#prepareMs, Math.floor(budgetMs / 2))), Math.min(GRACE_MS, Math.floor(budgetMs / 4)));
        } catch (error) { failure = error; }
      }
      return await inTransaction(this.pool, async db => {
        const query: Query = db.query.bind(db);
        await query(`SET LOCAL lock_timeout = '${LOCK_MS}ms'`);
        // Erasure locks the space row first; so does completion.
        const space = (await query(`SELECT lifecycle FROM spaces WHERE space_id=$1 FOR KEY SHARE`, [job.spaceId])).rows[0];
        const leased = (await query(`SELECT 1 FROM retrieval_outbox WHERE job_id=$1 AND attempts=$2 AND available_at=$3::timestamptz
          AND available_at>clock_timestamp() AND delivery_state='pending' FOR UPDATE`, [job.jobId, job.attempt, job.lease])).rows[0];
        if (!leased) return 'lost';
        const now = await currentTarget(query, job);
        if (!space || !['active', 'readOnly'].includes(space.lifecycle) || !now.open || (read.target || now.target)
          && !sameTarget(read.target, now.target)) {
          // Scope closed, or the Ref changed after it was read: run again with fresh state.
          await this.release(query, job, 0, null);
          return 'released';
        }
        const blocked = now.target ? await applyTarget(query, now.target) : [];
        if (now.target && !await authorityHolds(query, now.target)) throw new AuthorityChanged();
        if (blocked.length) {
          const retry = retryOf(failure ?? new ProjectionIncompleteError('Embeddings are missing for this revision'), job.attempt);
          await this.release(query, job, retry.delayMs, retry.error);
          return 'retried';
        }
        await query(`UPDATE retrieval_outbox SET delivery_state='delivered',delivered_at=clock_timestamp(),
          available_at=clock_timestamp(),last_error=NULL WHERE job_id=$1`, [job.jobId]);
        return 'applied';
      });
    } catch (error) {
      if (error instanceof CommitOutcomeUnknownError) return 'unknown';
      if (error instanceof AuthorityChanged) return this.settle(job, 'release', null, 0).catch(() => 'released' as const);
      const retry = retryOf(error, job.attempt);
      await this.settle(job, 'retry', retry.error, retry.delayMs).catch(() => {});
      return 'retried';
    }
  }

  private async settle(job: Job, outcome: 'release' | 'retry', error: string | null, delayMs: number): Promise<'released' | 'retried'> {
    await inTransaction(this.pool, db => this.release(db.query.bind(db), job, delayMs, error));
    return outcome === 'release' ? 'released' : 'retried';
  }

  /** Return a still-current lease to the due queue after `delayMs`, recording `error` when given. */
  private async release(query: Query, job: Job, delayMs: number, error: string | null): Promise<void> {
    await query(`UPDATE retrieval_outbox SET available_at=clock_timestamp()+($4::integer * interval '1 millisecond'),
        last_error=COALESCE($5::text,last_error)
      WHERE job_id=$1 AND attempts=$2 AND available_at=$3::timestamptz AND delivery_state='pending'`,
    [job.jobId, job.attempt, job.lease, delayMs, error]);
  }

  /** Make claimed items the step could not start due again at once; their attempts are unchanged. */
  private async releaseUnstarted(jobs: Job[]): Promise<void> {
    await inTransaction(this.pool, db => db.query(`UPDATE retrieval_outbox o SET available_at=clock_timestamp()
      FROM unnest($1::text[],$2::text[]) AS j(job_id,lease)
      WHERE o.job_id=j.job_id AND o.available_at=j.lease::timestamptz AND o.delivery_state='pending'`,
    [jobs.map(job => job.jobId), jobs.map(job => job.lease)]));
  }

  /**
   * A collection's projection state: `degraded` when sampled record or
   * evidence work has failed or a vector generation has no configured
   * embedder in a region its policies allow, `pending` when work is waiting,
   * otherwise `current`. Each queue's counts cover at most its 500
   * oldest-due rows; `capped` marks them as lower bounds. Exact reads and
   * writes never depend on this state.
   */
  async status(spaceId: string, collectionId: string): Promise<ProjectionStatus> {
    const space = text(spaceId, 512);
    const collection = text(collectionId, 512);
    return inTransaction(this.pool, async db => {
      const records = (await db.query(`SELECT count(*)::int AS live,
          count(*) FILTER (WHERE failures>0 OR delivery_state='degraded' OR last_error IS NOT NULL)::int AS degraded,
          (array_agg(last_error ORDER BY available_at DESC) FILTER (WHERE last_error IS NOT NULL))[1] AS last_error
        FROM (SELECT failures,delivery_state,last_error,available_at FROM projection_outbox
          WHERE space_id=$1 AND collection_id=$2 AND ${LIVE_OUTBOX} ORDER BY available_at,event_id LIMIT $3) o`,
      [space, collection, STATUS_SAMPLE])).rows[0];
      const failed = (await db.query(`SELECT count(*)::int AS degraded FROM (SELECT 1 FROM projection_outbox
          WHERE space_id=$1 AND collection_id=$2 AND ${FAILED_OUTBOX} LIMIT $3) f`, [space, collection, STATUS_SAMPLE])).rows[0];
      const evidence = (await db.query(`SELECT count(*)::int AS live,
          count(*) FILTER (WHERE last_error IS NOT NULL)::int AS degraded, min(enqueued_at) AS oldest,
          (array_agg(last_error ORDER BY available_at DESC) FILTER (WHERE last_error IS NOT NULL))[1] AS last_error
        FROM (SELECT last_error,available_at,enqueued_at FROM retrieval_outbox
          WHERE space_id=$1 AND collection_id=$2 AND delivery_state='pending' ORDER BY available_at,job_id LIMIT $3) o`,
      [space, collection, STATUS_SAMPLE])).rows[0];
      const views = (await loadGenerations(db.query.bind(db), space, collection)).map(entry => ({
        generation: entry.generation, state: entry.state, policyVersion: entry.policyVersion, lexical: entry.lexical,
        vector: entry.vector, embedder: entry.identity, embedderAvailable: entry.identity
          ? this.#embedders.resolve(entry.identity, entry.regions, CHUNK_CODE_POINTS) !== null : null }));
      const recordsDegraded = Math.max(records.degraded, failed.degraded);
      const view: ProjectionStatus = { spaceId: space, collectionId: collection, state: 'current',
        records: { pending: records.live - records.degraded, degraded: recordsDegraded,
          capped: records.live >= STATUS_SAMPLE || failed.degraded >= STATUS_SAMPLE, lastError: records.last_error },
        evidence: { pending: evidence.live - evidence.degraded, degraded: evidence.degraded, capped: evidence.live >= STATUS_SAMPLE,
          oldestPendingAt: evidence.oldest ? new Date(evidence.oldest).toISOString() : null, lastError: evidence.last_error },
        generations: views };
      if (recordsDegraded || evidence.degraded || views.some(entry => entry.embedderAvailable === false)) view.state = 'degraded';
      else if (records.live || evidence.live) view.state = 'pending';
      return view;
    });
  }
}

export interface ProjectionQueueStatus { pending: number; degraded: number; capped: boolean; lastError: string | null }
export interface ProjectionGenerationStatus {
  generation: number; state: 'building' | 'verifying' | 'active'; policyVersion: number; lexical: boolean; vector: boolean;
  embedder: EmbedderIdentity | null; embedderAvailable: boolean | null;
}
export interface ProjectionStatus {
  spaceId: string; collectionId: string; state: 'current' | 'pending' | 'degraded';
  records: ProjectionQueueStatus; evidence: ProjectionQueueStatus & { oldestPendingAt: string | null };
  generations: ProjectionGenerationStatus[];
}
