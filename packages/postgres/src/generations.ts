import { CHUNK_CODE_POINTS, PROJECTION_INCOMPLETE, ProjectionIncompleteError } from '@stateplane/retrieval';
import type { EmbedderIdentity, EmbeddingRegistry } from '@stateplane/retrieval';
import { AuthorityError, CommitOutcomeUnknownError } from './index.js';
import { bounded, DeadlineExceededError, inTransaction, infrastructureFault, text } from './faults.js';
import type { PoolLike } from './faults.js';
import { applyTarget, authorityHolds, budgeted, chunksFor, compare, complete, configures, currentTarget, GRACE_MS,
  loadGenerations, prepareTarget, retrievalOptions, retryOf, scopeOpen } from './retrieval.js';
import type { Generation, Outages, Query, RefKind, RetrievalOptions, Target } from './retrieval.js';

// Initial protective bounds, not measured capacity
// (docs/retrieval-projections.md#bounds-of-rebuilds).
// Refs read from authority per page.
const PAGE = 50;
// A rebuild's lease outlasts the longest step (60 s) and its settling.
const LEASE_MS = 120_000;
// A Ref is started only with at least this much of the step left.
const MIN_REF_MS = 1_000;
// One Ref's apply, and every control transaction, ends within this.
const REF_MS = 20_000;
const CONTROL_MS = 10_000;
// Activation, rollback and retirement wait this long for writers and searches holding the generations.
const CONTROL_LOCK_MS = 5_000;
// Chunk and checkpoint rows removed per statement from a retired generation.
const PRUNE_BATCH = 500;
// Refs that failed verification kept for the operator.
const MISMATCH_SAMPLE = 20;
// Kinds in key order, so (kind, id) orders every Ref of a collection.
const KINDS: readonly RefKind[] = ['claim', 'record', 'source'];

export type GenerationState = 'building' | 'verifying' | 'active' | 'standby' | 'retired';
export type RebuildPhase = 'backfill' | 'verify' | 'verified' | 'failed' | 'abandoned';
export interface RebuildMismatch { kind: RefKind; id: string; reason: 'failed' | 'incomplete' }
export interface RebuildView {
  phase: RebuildPhase; cursor: { kind: RefKind; id: string } | null;
  backfilled: number; verified: number; repaired: number; mismatched: number; mismatches: RebuildMismatch[];
  attempts: number; availableAt: string; lastError: string | null; backfilledAt: string | null; verifiedAt: string | null;
}
export interface GenerationView {
  spaceId: string; collectionId: string; generation: number; state: GenerationState; policyVersion: number;
  embedder: EmbedderIdentity | null; createdAt: string; verifyingAt: string | null; activatedAt: string | null;
  standbyAt: string | null; retiredAt: string | null; prunedAt: string | null; rebuild: RebuildView | null;
}
export interface GenerationStart {
  /** The embedder identity to migrate to; by default the registry selects one for the collection's current policy. */
  embedder?: EmbedderIdentity;
  /** The least relative quality a selected embedder may have. */
  minQuality?: number;
}
export interface GenerationStepOptions {
  /** Wall-clock budget for the step, 1,000 to 60,000 ms. A quarter at most goes to removing retired chunks. */
  budgetMs?: number;
}
export interface GenerationStep { rebuilds: number; refs: number; pruned: number }

/** A leased rebuild. `lease` is the exact `available_at` the claim set; only it may move the job. */
interface Job {
  spaceId: string; collectionId: string; generation: number; phase: 'backfill' | 'verify'; lease: string; attempts: number;
  cursor: { kind: RefKind; id: string } | null;
}
type Cursor = { kind: RefKind; id: string } | null;
/**
 * Progress not yet written to the job: the cursor it was last written at
 * (`from`), the last Ref finished since and the counters those Refs moved.
 * A write applies only while the job's cursor is still `from`, so progress
 * is written once: after an unacknowledged commit that did land, the same
 * progress written again changes nothing.
 */
interface Progress { from: Cursor; cursor: Cursor; done: number; repaired: number; mismatches: RebuildMismatch[] }
type Outcome = 'current' | 'applied' | 'mismatch' | 'skipped' | 'changed' | 'closed' | 'lost' | 'gone';

const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const transientFault = (error: unknown) => infrastructureFault(error) || error instanceof DeadlineExceededError
  || (error as { code?: unknown })?.code === PROJECTION_INCOMPLETE;
const control = (until = Infinity) => ({ deadline: Math.min(until, Date.now() + CONTROL_MS) });
/** A transaction the budget cut short; a step then just ends. */
const cutShort = (error: unknown) => error instanceof DeadlineExceededError
  || error instanceof CommitOutcomeUnknownError && error.cause instanceof DeadlineExceededError;
/** The generation insert trigger's refusals when the collection's head moved after `start` read it. */
const RACED = new Set(['projection_generations_pending', 'projection_generations_policy', 'projection_generations_order']);
/** A lock wait that ran out, or a deadlock: another session holds the generations or the job. */
const busy = (error: unknown) => ['55P03', '40P01'].includes((error as { code?: unknown })?.code as string);

function identityOf(value: unknown): EmbedderIdentity {
  const identity = value as EmbedderIdentity;
  if (!identity || typeof identity !== 'object' || typeof identity.embedder !== 'string' || typeof identity.model !== 'string'
    || typeof identity.modelVersion !== 'string' || !Number.isSafeInteger(identity.dimensions)) throw new AuthorityError('INVALID_ARGUMENT');
  return { embedder: identity.embedder, model: identity.model, modelVersion: identity.modelVersion, dimensions: identity.dimensions };
}

/** Whether the generation holds exactly `target`: deleted, or live at its revision and extraction with every chunk. */
async function holds(query: Query, target: Target, generation: Generation): Promise<boolean> {
  const row = (await query(`SELECT revision,extraction_version,deleted FROM projection_refs WHERE space_id=$1 AND collection_id=$2
    AND generation=$3 AND ref_kind=$4 AND ref_id=$5`, [target.spaceId, target.collectionId, generation.generation, target.kind,
    target.id])).rows[0];
  if (target.deleted) return row?.deleted === true;
  return row !== undefined && !row.deleted && compare(row, target) === 0
    && await complete(query, target, generation, chunksFor(generation, target).length);
}

/** A Ref's current authoritative state, with its space's placement and whether its space and collection are open. */
async function readRef(query: Query, spaceId: string, collectionId: string, kind: RefKind, id: string)
  : Promise<{ open: boolean; target: Target | null }> {
  if (kind !== 'record') return currentTarget(query, { spaceId, collectionId, kind, id });
  const row = (await query(`SELECT r.revision,r.tombstone,r.canonical_data,s.placement_generation AS placement,
      s.lifecycle IN ('active','readOnly') AND c.lifecycle<>'deleted' AS open
    FROM records r JOIN spaces s ON s.space_id=r.space_id JOIN collections c ON c.space_id=r.space_id AND c.collection_id=r.collection_id
    WHERE r.space_id=$1 AND r.collection_id=$2 AND r.record_id=$3`, [spaceId, collectionId, id])).rows[0];
  if (!row) return { open: false, target: null };
  return { open: row.open, target: { spaceId, collectionId, kind, id, revision: Number(row.revision), extractionVersion: null,
    deleted: row.tombstone, content: row.tombstone ? null : row.canonical_data, placement: Number(row.placement) } };
}

/** The authority fence failed: the Ref changed after it was read. The apply rolls back and the Ref runs again. */
class RefChanged extends Error {}
/** The job is no longer at the progress's cursor: the apply rolls back and the step leaves the job. */
class ProgressDiverged extends Error {}

/**
 * Rebuilds, verification, activation, rollback and retirement of a
 * collection's projection generations (STA-48). A rebuild is a new
 * generation under the collection's current policy and, when it enables
 * vectors, an embedder chosen for it (or named, to migrate models), filled
 * from authority by a resumable job, then verified against authority. Only a
 * verified generation can become active; the one it replaces stays on
 * standby, still projected, until a rollback restores it or it is retired.
 * Retired generations' chunks and checkpoints are then removed; projected
 * Refs and deletion receipts stay until erasure. Every write takes the scope
 * fence first, as every retrieval write does. These are operator and service
 * operations; transports come with STA-49.
 */
export class PostgresProjectionGenerations {
  readonly #embedders: EmbeddingRegistry;
  readonly #prepareMs: number;
  constructor(private readonly pool: PoolLike, settings: RetrievalOptions = {}) {
    ({ embedders: this.#embedders, prepareMs: this.#prepareMs } = retrievalOptions(settings));
  }

  /**
   * Start a rebuild: a new building generation, numbered after every earlier
   * one, under the collection's current policy, and its job. With vectors,
   * the embedder is `embedder` (a model migration) when configured in a
   * region the policy allows with a dimension the cell indexes, or else the
   * registry's selection; with none, nothing starts (`EMBEDDER_UNAVAILABLE`).
   * One generation of a collection is built or verified at a time (`CONFLICT`).
   */
  async start(spaceId: string, collectionId: string, options: GenerationStart = {}): Promise<GenerationView> {
    const space = text(spaceId, 512);
    const collection = text(collectionId, 512);
    const wanted = options.embedder === undefined ? null : identityOf(options.embedder);
    const minQuality = options.minQuality ?? 0;
    if (typeof minQuality !== 'number' || !Number.isFinite(minQuality)) throw new AuthorityError('INVALID_ARGUMENT');
    const generation = await this.controlled(async query => {
      await this.open(query, space, collection);
      // Read, not locked: the operational role may only read the head. The insert trigger locks it with owner rights
      // and refuses the generation when a policy or another generation was published since (CONFLICT, nothing inserted).
      const head = (await query(`SELECT h.policy_version,h.generation,p.vector,p.processing_regions
        FROM retrieval_collection_heads h JOIN retrieval_policies p ON p.space_id=h.space_id AND p.collection_id=h.collection_id
          AND p.version=h.policy_version
        WHERE h.space_id=$1 AND h.collection_id=$2`, [space, collection])).rows[0];
      if (!head) throw new AuthorityError('NOT_FOUND', 'The collection has no retrieval policy');
      let identity: EmbedderIdentity | null = null;
      if (head.vector) {
        const dimensions = (await query('SELECT dimensions FROM vector_index_strategies')).rows.map(row => Number(row.dimensions));
        const embedder = wanted
          ? dimensions.includes(wanted.dimensions) ? this.#embedders.resolve(wanted, head.processing_regions, CHUNK_CODE_POINTS) : null
          : this.#embedders.select({ regions: head.processing_regions, dimensions, inputCodePoints: CHUNK_CODE_POINTS, minQuality });
        if (!embedder) throw new AuthorityError('EMBEDDER_UNAVAILABLE', 'No configured embedder for this generation in a region its policy allows');
        const { embedder: name, model, modelVersion } = embedder.profile;
        identity = { embedder: name, model, modelVersion, dimensions: embedder.profile.dimensions };
      } else if (wanted) throw new AuthorityError('INVALID_ARGUMENT', 'The retrieval policy does not enable vectors');
      const next = Number(head.generation) + 1;
      try {
        await query(`INSERT INTO projection_generations(space_id,collection_id,generation,policy_version,embedder,embedding_model,
          model_version,dimensions) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [space, collection, next, head.policy_version,
          identity?.embedder ?? null, identity?.model ?? null, identity?.modelVersion ?? null, identity?.dimensions ?? null]);
      } catch (error) {
        if (RACED.has((error as { constraint?: string }).constraint ?? ''))
          throw new AuthorityError('CONFLICT', 'Another generation of this collection is being built or verified, or its policy changed');
        throw error;
      }
      await query('INSERT INTO projection_rebuilds(space_id,collection_id,generation) VALUES($1,$2,$3)', [space, collection, next]);
      return next;
    });
    return (await this.list(space, collection)).find(view => view.generation === generation)!;
  }

  /** Every generation of a collection, retired ones included, oldest first, with its rebuild's progress. */
  async list(spaceId: string, collectionId: string): Promise<GenerationView[]> {
    const space = text(spaceId, 512);
    const collection = text(collectionId, 512);
    const rows = (await inTransaction(this.pool, db => db.query(`SELECT g.*,r.phase,r.cursor_kind,r.cursor_id,r.backfilled,
        r.verified,r.repaired,r.mismatched,r.mismatches,r.attempts,r.available_at,r.last_error,r.backfilled_at,r.verified_at
      FROM projection_generations g LEFT JOIN projection_rebuilds r USING (space_id,collection_id,generation)
      WHERE g.space_id=$1 AND g.collection_id=$2 ORDER BY g.generation`, [space, collection]), control())).rows;
    return rows.map(row => ({ spaceId: space, collectionId: collection, generation: Number(row.generation), state: row.state,
      policyVersion: Number(row.policy_version), embedder: row.embedder === null ? null : { embedder: row.embedder,
        model: row.embedding_model, modelVersion: row.model_version, dimensions: Number(row.dimensions) },
      createdAt: iso(row.created_at)!, verifyingAt: iso(row.verifying_at), activatedAt: iso(row.activated_at),
      standbyAt: iso(row.standby_at), retiredAt: iso(row.retired_at), prunedAt: iso(row.pruned_at),
      rebuild: row.phase === null ? null : { phase: row.phase,
        cursor: row.cursor_kind === null ? null : { kind: row.cursor_kind, id: row.cursor_id },
        backfilled: Number(row.backfilled), verified: Number(row.verified), repaired: Number(row.repaired),
        mismatched: Number(row.mismatched), mismatches: row.mismatches, attempts: row.attempts, availableAt: iso(row.available_at)!,
        lastError: row.last_error, backfilledAt: iso(row.backfilled_at), verifiedAt: iso(row.verified_at) } }));
  }

  /**
   * Activate a verified generation in one transaction: the standby
   * generation, if any, retires; the active one, if any, steps down to
   * standby; this one becomes active. Search sees the old generation or the
   * new one, never neither. A generation that has not passed verification is
   * refused (`PRECONDITION_FAILED`) and the active one stays.
   */
  async activate(spaceId: string, collectionId: string, generation: number): Promise<GenerationView[]> {
    const space = text(spaceId, 512);
    const collection = text(collectionId, 512);
    const number = bounded(generation, 1, Number.MAX_SAFE_INTEGER);
    await this.controlled(async query => {
      const states = await this.lockStates(query, space, collection);
      if (states.get(number) !== 'verifying') throw new AuthorityError('CONFLICT', 'Only a generation being verified can be activated');
      const phase = (await query(`SELECT phase FROM projection_rebuilds WHERE space_id=$1 AND collection_id=$2 AND generation=$3
        FOR UPDATE`, [space, collection, number])).rows[0]?.phase;
      if (phase !== 'verified') throw new AuthorityError('PRECONDITION_FAILED', 'The generation has not passed verification');
      // One statement per step, in this order, so each partial unique index holds after every row.
      for (const [from, to] of [['standby', 'retired'], ['active', 'standby']] as const)
        await this.move(query, space, collection, [...states].find(([, state]) => state === from)?.[0], to);
      await this.move(query, space, collection, number, 'active');
    });
    return this.list(space, collection);
  }

  /**
   * Roll back the last activation: the active generation retires and the
   * standby one, which the worker kept projecting, becomes active again in
   * the same transaction. Without a standby generation nothing changes
   * (`PRECONDITION_FAILED`).
   */
  async rollback(spaceId: string, collectionId: string): Promise<GenerationView[]> {
    const space = text(spaceId, 512);
    const collection = text(collectionId, 512);
    await this.controlled(async query => {
      const states = [...await this.lockStates(query, space, collection)];
      const standby = states.find(([, state]) => state === 'standby')?.[0];
      if (standby === undefined) throw new AuthorityError('PRECONDITION_FAILED', 'No generation is on standby');
      await this.move(query, space, collection, states.find(([, state]) => state === 'active')?.[0], 'retired');
      await this.move(query, space, collection, standby, 'active');
    });
    return this.list(space, collection);
  }

  /**
   * Retire a generation that is being built or verified (abandoning its
   * rebuild: an unfinished job ends `abandoned` in the same transaction and
   * is never leased again) or on standby. The active generation is not retired here
   * (`CONFLICT`): a rollback or another activation replaces it. Retiring
   * waits for writers already in the generation; its chunks and checkpoints
   * are removed by later steps. Retiring a retired generation changes nothing.
   */
  async retire(spaceId: string, collectionId: string, generation: number): Promise<GenerationView> {
    const space = text(spaceId, 512);
    const collection = text(collectionId, 512);
    const number = bounded(generation, 1, Number.MAX_SAFE_INTEGER);
    await this.controlled(async query => {
      await this.open(query, space, collection);
      const state = (await query(`SELECT state FROM projection_generations WHERE space_id=$1 AND collection_id=$2 AND generation=$3
        FOR UPDATE`, [space, collection, number])).rows[0]?.state;
      if (state === undefined) throw new AuthorityError('NOT_FOUND', 'No such generation');
      if (state === 'active') throw new AuthorityError('CONFLICT', 'The active generation is replaced by rollback or activation');
      if (state === 'retired') return;
      await this.move(query, space, collection, number, 'retired');
      // The generation before its job, as everywhere; a step holding the job's lease then finds it ended.
      await query(`UPDATE projection_rebuilds SET phase='abandoned' WHERE space_id=$1 AND collection_id=$2 AND generation=$3
        AND phase IN ('backfill','verify')`, [space, collection, number]);
    });
    return (await this.list(space, collection)).find(view => view.generation === number)!;
  }

  /**
   * Start verification of a verified or failed generation again, from the
   * collection's first Ref, for example after the failure it reported was
   * fixed. Only a generation still being verified can be reverified.
   */
  async reverify(spaceId: string, collectionId: string, generation: number): Promise<GenerationView> {
    const space = text(spaceId, 512);
    const collection = text(collectionId, 512);
    const number = bounded(generation, 1, Number.MAX_SAFE_INTEGER);
    await this.controlled(async query => {
      await this.open(query, space, collection);
      // The generation before its job, as everywhere: an activation either committed first and is seen here, or waits.
      const state = (await query(`SELECT state FROM projection_generations WHERE space_id=$1 AND collection_id=$2 AND generation=$3
        FOR SHARE`, [space, collection, number])).rows[0]?.state;
      const updated = state !== 'verifying' ? null : await query(`UPDATE projection_rebuilds SET phase='verify',cursor_kind=NULL,
          cursor_id=NULL,verified=0,repaired=0,mismatched=0,mismatches='[]',verified_at=NULL,available_at=clock_timestamp()
        WHERE space_id=$1 AND collection_id=$2 AND generation=$3 AND phase IN ('verified','failed')`, [space, collection, number]);
      if (updated?.rowCount !== 1) throw new AuthorityError('CONFLICT', 'Only a generation with a finished verification can be reverified');
    });
    return (await this.list(space, collection)).find(view => view.generation === number)!;
  }

  /**
   * Advance rebuilds and remove retired generations' chunks, within the
   * budget. Removal gets at most a quarter of it first. Then due rebuilds are
   * leased one at a time and each is advanced, page by page, until its phase
   * ends, it backs off or the budget does; the cursor moves after every Ref,
   * so an interrupted step resumes after the last Ref it finished.
   */
  async step(settings: GenerationStepOptions = {}): Promise<GenerationStep> {
    const budgetMs = bounded(settings.budgetMs ?? 10_000, MIN_REF_MS, 60_000);
    const until = Date.now() + budgetMs;
    const result: GenerationStep = { rebuilds: 0, refs: 0, pruned: 0 };
    // A failed removal is retried by a later step; rebuilds still advance in this one, and the failure is then thrown.
    let failure: unknown = null;
    try { await this.prune(Date.now() + Math.floor(budgetMs / 4), result); } catch (error) { if (!cutShort(error)) failure = error; }
    const outages: Outages = new Set();
    while (until - Date.now() >= MIN_REF_MS) {
      let job: Job | null;
      try { job = await this.claim(until); } catch (error) {
        if (cutShort(error)) break;
        throw error;
      }
      if (!job) break;
      result.rebuilds++;
      result.refs += await this.advance(job, until, outages);
    }
    if (failure) throw failure;
    return result;
  }

  /**
   * Remove chunks and checkpoints of retired generations in batches until none is left or `until`, counting rows removed.
   * A generation another step is pruning, or whose scope closed meanwhile, is passed over for the rest of this step.
   */
  private async prune(until: number, result: GenerationStep): Promise<void> {
    const passed: { s: string; c: string; g: number }[] = [];
    while (Date.now() < until) {
      const batch = await inTransaction(this.pool, async db => {
        const query: Query = db.query.bind(db);
        const found = (await query(`SELECT g.space_id,g.collection_id,g.generation FROM projection_generations g
          JOIN spaces s ON s.space_id=g.space_id AND s.lifecycle IN ('active','readOnly')
          JOIN collections c ON c.space_id=g.space_id AND c.collection_id=g.collection_id AND c.lifecycle<>'deleted'
          WHERE g.state='retired' AND g.pruned_at IS NULL
            AND NOT $1::jsonb @> jsonb_build_array(jsonb_build_object('s',g.space_id,'c',g.collection_id,'g',g.generation))
          ORDER BY g.retired_at,g.space_id,g.collection_id,g.generation LIMIT 1`, [JSON.stringify(passed)])).rows[0];
        if (!found) return null;
        const key = [found.space_id, found.collection_id, found.generation];
        const pass = { pass: { s: found.space_id, c: found.collection_id, g: Number(found.generation) } };
        // The scope fence first, as erasure locks the space first; then the generation, unless another step prunes it.
        if (!await scopeOpen(query, found.space_id, found.collection_id)) return pass;
        if (!(await query(`SELECT 1 FROM projection_generations WHERE space_id=$1 AND collection_id=$2 AND generation=$3
          AND state='retired' AND pruned_at IS NULL FOR UPDATE SKIP LOCKED`, key)).rows[0]) return pass;
        let rows = 0;
        for (const table of ['embedding_checkpoints', 'vector_chunks', 'lexical_chunks'])
          rows += (await query(`DELETE FROM ${table} WHERE ctid=ANY(ARRAY(SELECT ctid FROM ${table}
            WHERE space_id=$1 AND collection_id=$2 AND generation=$3 LIMIT ${PRUNE_BATCH}))`, key)).rowCount ?? 0;
        if (rows === 0) await query(`UPDATE projection_generations SET pruned_at=clock_timestamp() WHERE space_id=$1
          AND collection_id=$2 AND generation=$3`, key);
        return { rows };
      }, { deadline: until });
      if (batch === null) break;
      if ('pass' in batch) passed.push(batch.pass);
      else result.pruned += batch.rows;
    }
  }

  /**
   * Lease the rebuild due longest whose generation is in its phase's state,
   * whose space and collection are open and, for a vector generation, whose
   * embedder this stepper's registry resolves. A rebuild it cannot embed is
   * left due exactly as it is (attempts, error and cursor unchanged) for a
   * stepper that can, so a cell without a configured embedder still advances
   * lexical rebuilds and never holds back a model migration. The query itself
   * leaves those out, so however many wait the claim reads none of them.
   */
  private async claim(until: number): Promise<Job | null> {
    return inTransaction(this.pool, async db => {
      const query: Query = db.query.bind(db);
      const passed: { s: string; c: string; g: number }[] = [];
      for (;;) {
        // Not locked here: the lease below rechecks the job, so a job another step leases meanwhile is just passed;
        // only such races repeat this query.
        const due = (await query(`SELECT r.space_id,r.collection_id,r.generation
          FROM projection_rebuilds r
            JOIN projection_generations g ON g.space_id=r.space_id AND g.collection_id=r.collection_id AND g.generation=r.generation
            JOIN spaces s ON s.space_id=r.space_id AND s.lifecycle IN ('active','readOnly')
            JOIN collections c ON c.space_id=r.space_id AND c.collection_id=r.collection_id AND c.lifecycle<>'deleted'
          WHERE r.phase IN ('backfill','verify') AND r.available_at<=clock_timestamp()
            AND g.state=CASE r.phase WHEN 'backfill' THEN 'building' ELSE 'verifying' END
            -- A vector generation only with an embedder the registry resolves: its identity in a region both its
            -- policy and the collection's current one allow (the regions loadGenerations gives it).
            AND (g.embedder IS NULL OR EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb)
                AS e(embedder text,model text,"modelVersion" text,dimensions integer,region text)
              JOIN retrieval_policies p ON p.space_id=g.space_id AND p.collection_id=g.collection_id AND p.version=g.policy_version
              JOIN retrieval_collection_heads h ON h.space_id=g.space_id AND h.collection_id=g.collection_id
              JOIN retrieval_policies hp ON hp.space_id=h.space_id AND hp.collection_id=h.collection_id AND hp.version=h.policy_version
              WHERE e.embedder=g.embedder AND e.model=g.embedding_model AND e."modelVersion"=g.model_version
                AND e.dimensions=g.dimensions AND e.region=ANY(p.processing_regions) AND e.region=ANY(hp.processing_regions)))
            AND NOT $1::jsonb @> jsonb_build_array(jsonb_build_object('s',r.space_id,'c',r.collection_id,'g',r.generation))
          ORDER BY r.available_at,r.space_id,r.collection_id,r.generation LIMIT 1`,
        [JSON.stringify(passed), JSON.stringify(this.#embedders.resolvable(CHUNK_CODE_POINTS))])).rows[0];
        if (!due) return null;
        const key = [due.space_id, due.collection_id, due.generation];
        const row = (await query(`UPDATE projection_rebuilds r
            SET available_at=clock_timestamp()+($4::integer * interval '1 millisecond'),attempts=r.attempts+1
          FROM (SELECT space_id,collection_id,generation FROM projection_rebuilds WHERE space_id=$1 AND collection_id=$2
            AND generation=$3 AND phase IN ('backfill','verify') AND available_at<=clock_timestamp() FOR UPDATE SKIP LOCKED) due
          WHERE r.space_id=due.space_id AND r.collection_id=due.collection_id AND r.generation=due.generation
          RETURNING r.space_id,r.collection_id,r.generation,r.phase,r.cursor_kind,r.cursor_id,r.attempts,
            r.available_at::text AS lease`, [...key, LEASE_MS])).rows[0];
        if (!row) { passed.push({ s: due.space_id, c: due.collection_id, g: Number(due.generation) }); continue; }
        return { spaceId: row.space_id, collectionId: row.collection_id, generation: Number(row.generation), phase: row.phase,
          lease: row.lease, attempts: row.attempts,
          cursor: row.cursor_kind === null ? null : { kind: row.cursor_kind, id: row.cursor_id } };
      }
    }, { deadline: until });
  }

  /** The next Refs after the job's cursor, in key order, of the kinds the generation configures. */
  private async page(job: Job, generation: Generation, until: number): Promise<{ kind: RefKind; id: string }[]> {
    return inTransaction(this.pool, async db => {
      const refs: { kind: RefKind; id: string }[] = [];
      for (const kind of KINDS) {
        if (refs.length >= PAGE || !configures(generation, kind)) continue;
        if (job.cursor && kind < job.cursor.kind) continue;
        const after = job.cursor?.kind === kind ? job.cursor.id : null;
        const ids = kind === 'record'
          ? await db.query(`SELECT record_id AS id FROM records WHERE space_id=$1 AND collection_id=$2
              AND ($3::text IS NULL OR record_id>$3) ORDER BY record_id LIMIT $4`, [job.spaceId, job.collectionId, after, PAGE - refs.length])
          : await db.query(`SELECT entity_id AS id FROM entity_refs WHERE space_id=$1 AND collection_id=$2 AND kind=$5
              AND ($3::text IS NULL OR entity_id>$3) ORDER BY entity_id LIMIT $4`, [job.spaceId, job.collectionId, after, PAGE - refs.length, kind]);
        refs.push(...ids.rows.map(row => ({ kind, id: row.id as string })));
      }
      return refs;
    }, control(until));
  }

  /**
   * Advance one leased job until its phase ends, it backs off, its lease is
   * lost or the budget ends (then it is released, due at once). Each Ref is
   * read from authority; one the generation already holds exactly passes;
   * any other is prepared and applied to this generation alone, as the
   * worker applies it, under the scope fence, the lease and the authority
   * fence, with the cursor moved in the same transaction. In verification
   * such a Ref is a repair, and one that still cannot be held (the embedder
   * refused its content) is a mismatch that fails verification. An outage or
   * an interrupted preparation backs the job off without moving past the
   * Ref; in the backfill any other failure does too, so no Ref is ever
   * skipped. Returns the Refs finished.
   */
  private async advance(claimed: Job, until: number, outages: Outages): Promise<number> {
    let job = claimed;
    const progress: Progress = { from: job.cursor, cursor: job.cursor, done: 0, repaired: 0, mismatches: [] };
    // Progress was written: it is now the job's.
    const reset = () => Object.assign(progress, { from: progress.cursor, done: 0, repaired: 0, mismatches: [] });
    let finished = 0;
    try {
      for (;;) {
        if (until - Date.now() < MIN_REF_MS) { await this.settle(job, progress, 0, null, until); return finished; }
        const generation = (await inTransaction(this.pool, db => loadGenerations(db.query.bind(db), job.spaceId, job.collectionId,
          job.generation), control(until)))[0];
        if (!generation) return finished;
        const refs = await this.page({ ...job, cursor: progress.cursor }, generation, until);
        if (!refs.length) {
          if (!await this.finishPhase(job, progress, until) || job.phase === 'verify') return finished;
          job = { ...job, phase: 'verify', cursor: null };
          Object.assign(progress, { cursor: null });
          reset();
          continue;
        }
        for (const ref of refs) {
          if (until - Date.now() < MIN_REF_MS) { await this.settle(job, progress, 0, null, until); return finished; }
          let outcome: Outcome;
          try { outcome = await this.project(job, generation, ref, progress, until, outages); } catch (error) {
            // An unacknowledged commit is not the Ref's failure: the job stops and resumes from what is durable.
            if (error instanceof CommitOutcomeUnknownError) throw error;
            if (job.phase === 'backfill' || transientFault(error)) {
              const retry = retryOf(error, finished ? 1 : job.attempts);
              await this.settle(job, progress, retry.delayMs, retry.error, until);
              return finished;
            }
            // The Ref's own failure in verification: recorded, and verification goes on.
            progress.mismatches.push({ kind: ref.kind, id: ref.id, reason: 'failed' });
            progress.cursor = ref;
            if (!await this.save(job, progress, until)) return finished;
            reset();
            finished++;
            continue;
          }
          if (outcome === 'lost' || outcome === 'gone') return finished;
          if (outcome === 'closed' || outcome === 'changed') { await this.settle(job, progress, 0, null, until); return finished; }
          progress.cursor = ref;
          // An applied Ref or a mismatch was written with its apply; a Ref that passes is written with the next one.
          if (outcome === 'applied' || outcome === 'mismatch') reset();
          else progress.done++;
          finished++;
        }
        if (!await this.save(job, progress, until)) return finished;
        reset();
      }
    } catch (error) {
      // After an unacknowledged commit the job may already hold this progress; settling writes it only if not.
      if (cutShort(error)) await this.settle(job, progress, 0, null, until).catch(() => {});
      else {
        const retry = retryOf(error, finished ? 1 : job.attempts);
        await this.settle(job, progress, retry.delayMs, retry.error, until).catch(() => {});
      }
      return finished;
    }
  }

  /**
   * Bring one Ref of the generation to authority: 'current' when it already
   * holds it ('skipped' when the Ref has nothing to project yet); otherwise
   * prepare and apply, then 'applied', or 'mismatch' in verification when the
   * generation still does not hold it. 'changed' when authority moved before
   * commit, 'closed' when the scope did, 'lost' when the lease did and 'gone'
   * when the generation retired.
   */
  private async project(job: Job, generation: Generation, ref: { kind: RefKind; id: string }, progress: Progress, until: number,
    outages: Outages): Promise<Outcome> {
    const limit = () => ({ deadline: Math.min(until, Date.now() + REF_MS) });
    const read = await inTransaction(this.pool, async db => {
      const query: Query = db.query.bind(db);
      const found = await readRef(query, job.spaceId, job.collectionId, ref.kind, ref.id);
      return { ...found, held: found.open && found.target !== null && await holds(query, found.target, generation) };
    }, limit());
    if (!read.open) return 'closed';
    if (!read.target) return 'skipped';
    if (read.held) return 'current';
    const target = read.target;
    if (!target.deleted) {
      const left = until - Date.now();
      const prepareMs = Math.max(1, Math.min(this.#prepareMs, Math.floor(left / 2)));
      await budgeted((budget, saved, deadline, sql) => prepareTarget(this.pool, this.#embedders, target, budget, saved, deadline, sql,
        outages, generation.generation), AbortSignal.timeout(Math.max(1, left)), prepareMs, Math.min(GRACE_MS, Math.floor(prepareMs / 4)));
    }
    try {
      return await inTransaction(this.pool, async (db): Promise<Outcome> => {
        const query: Query = db.query.bind(db);
        if (!await scopeOpen(query, job.spaceId, job.collectionId, target.placement)) return 'closed';
        if (!await this.inPhase(query, job, 'SHARE')) return 'gone';
        if (!await this.leased(query, job)) return 'lost';
        const blocked = await applyTarget(query, target, generation.generation);
        if (blocked === null) return 'gone';
        if (!await authorityHolds(query, target)) throw new RefChanged();
        // Embeddings missing though preparation succeeded (its checkpoints were superseded): run the Ref again.
        if (blocked.length) throw new ProjectionIncompleteError('Embeddings are missing for this revision');
        const held = await holds(query, target, generation);
        if (!held && job.phase === 'backfill') throw new ProjectionIncompleteError('The generation does not hold the Ref');
        if (!await this.write(query, job, { from: progress.from, cursor: ref, done: progress.done + (held ? 1 : 0),
          repaired: progress.repaired + (held && job.phase === 'verify' ? 1 : 0),
          mismatches: held ? progress.mismatches : [...progress.mismatches, { kind: ref.kind, id: ref.id, reason: 'incomplete' }] }))
          throw new ProgressDiverged();
        return held ? 'applied' : 'mismatch';
      }, limit());
    } catch (error) {
      if (error instanceof RefChanged) return 'changed';
      if (error instanceof ProgressDiverged) return 'lost';
      throw error;
    }
  }

  /**
   * Lock the job's generation and report whether it is still in the job's
   * phase's state (`building` for the backfill, `verifying` for
   * verification). Every transaction that locks a generation and its job
   * locks the generation first, after the scope fence: the step's applies
   * and phase ends here, activation and reverification in their own way. So
   * none of them waits for another in a cycle, and a control operation that
   * changes the generation is seen by the next apply, which then stops.
   */
  private async inPhase(query: Query, job: Job, lock: 'SHARE' | 'UPDATE'): Promise<boolean> {
    const state = (await query(`SELECT state FROM projection_generations WHERE space_id=$1 AND collection_id=$2 AND generation=$3
      FOR ${lock}`, [job.spaceId, job.collectionId, job.generation])).rows[0]?.state;
    return state === (job.phase === 'backfill' ? 'building' : 'verifying');
  }

  /** Whether `job` still holds its lease, locking the job until commit. */
  private async leased(query: Query, job: Job): Promise<boolean> {
    return (await query(`SELECT 1 FROM projection_rebuilds WHERE space_id=$1 AND collection_id=$2 AND generation=$3
      AND phase=$4 AND available_at=$5::timestamptz AND available_at>clock_timestamp() FOR UPDATE`,
    [job.spaceId, job.collectionId, job.generation, job.phase, job.lease])).rows.length === 1;
  }

  /**
   * Write progress under the job's lease while the job's cursor is still
   * the one the progress started from: the cursor, the phase's counters and
   * up to `MISMATCH_SAMPLE` mismatches in all. Progress clears the last
   * error and counts only this lease as an attempt, so backoff grows only
   * while the job makes none. False when the lease is gone or the job has
   * moved past the progress (an unacknowledged commit that landed).
   */
  private async write(query: Query, job: Job, progress: Progress): Promise<boolean> {
    const backfill = job.phase === 'backfill';
    const updated = await query(`UPDATE projection_rebuilds SET cursor_kind=$6,cursor_id=$7,
        backfilled=backfilled+$8,verified=verified+$9,repaired=repaired+$10,mismatched=mismatched+jsonb_array_length($11::jsonb),
        mismatches=(SELECT COALESCE(jsonb_agg(m ORDER BY n),'[]') FROM jsonb_array_elements(mismatches || $11::jsonb)
          WITH ORDINALITY AS t(m,n) WHERE n<=${MISMATCH_SAMPLE}),
        attempts=CASE WHEN $8+$9>0 THEN 1 ELSE attempts END,
        last_error=CASE WHEN $8+$9>0 THEN NULL ELSE last_error END,
        last_error_at=CASE WHEN $8+$9>0 THEN NULL ELSE last_error_at END
      WHERE space_id=$1 AND collection_id=$2 AND generation=$3 AND phase=$4 AND available_at=$5::timestamptz
        AND cursor_kind IS NOT DISTINCT FROM $12::text AND cursor_id IS NOT DISTINCT FROM $13::text`,
    [job.spaceId, job.collectionId, job.generation, job.phase, job.lease, progress.cursor?.kind ?? null, progress.cursor?.id ?? null,
      backfill ? progress.done : 0, backfill ? 0 : progress.done, progress.repaired, JSON.stringify(progress.mismatches),
      progress.from?.kind ?? null, progress.from?.id ?? null]);
    return updated.rowCount === 1;
  }

  /** Write progress in a transaction of its own, under the job's lease. */
  private async save(job: Job, progress: Progress, until: number): Promise<boolean> {
    return inTransaction(this.pool, db => this.write(db.query.bind(db), job, progress), { deadline: Math.max(until, Date.now() + 1_000) });
  }

  /**
   * Write progress unless the job already moved past it, and release the
   * job under its lease, due after `delayMs`, recording `error` when given.
   * Ends at most 1 s after `until`.
   */
  private async settle(job: Job, progress: Progress, delayMs: number, error: string | null, until: number): Promise<void> {
    await inTransaction(this.pool, async db => {
      const query: Query = db.query.bind(db);
      await this.write(query, job, progress);
      await query(`UPDATE projection_rebuilds SET available_at=clock_timestamp()+($6::integer * interval '1 millisecond'),
          last_error=COALESCE($7::text,last_error),last_error_at=CASE WHEN $7::text IS NULL THEN last_error_at ELSE clock_timestamp() END
        WHERE space_id=$1 AND collection_id=$2 AND generation=$3 AND phase=$4 AND available_at=$5::timestamptz`,
      [job.spaceId, job.collectionId, job.generation, job.phase, job.lease, delayMs, error]);
    }, { deadline: Math.min(Date.now(), until) + 1_000 });
  }

  /**
   * End the job's phase under its lease and the scope fence. A finished
   * backfill moves the generation to verifying and starts verification under
   * the same lease; a finished verification is `verified` with no mismatch,
   * otherwise `failed`, and releases the job. False when the lease, the scope
   * or the generation is gone.
   */
  private async finishPhase(job: Job, progress: Progress, until: number): Promise<boolean> {
    return inTransaction(this.pool, async db => {
      const query: Query = db.query.bind(db);
      // A finished backfill moves its generation, so it locks it for that, waiting for writers already in it as retiring
      // does; a verification only keeps it in its state.
      if (!await scopeOpen(query, job.spaceId, job.collectionId) || !await this.inPhase(query, job, job.phase === 'backfill' ? 'UPDATE' : 'SHARE')
        || !await this.leased(query, job) || !await this.write(query, job, progress)) return false;
      const key = [job.spaceId, job.collectionId, job.generation];
      if (job.phase === 'verify') {
        await query(`UPDATE projection_rebuilds SET phase=CASE WHEN mismatched=0 THEN 'verified' ELSE 'failed' END,
          verified_at=clock_timestamp(),available_at=clock_timestamp() WHERE space_id=$1 AND collection_id=$2 AND generation=$3`, key);
        return true;
      }
      await query(`UPDATE projection_generations SET state='verifying' WHERE space_id=$1 AND collection_id=$2 AND generation=$3`, key);
      await query(`UPDATE projection_rebuilds SET phase='verify',cursor_kind=NULL,cursor_id=NULL,backfilled_at=clock_timestamp()
        WHERE space_id=$1 AND collection_id=$2 AND generation=$3`, key);
      return true;
    }, { deadline: Math.max(until, Date.now() + 1_000) });
  }

  /**
   * One control transaction, bounded like every other. Its lock waits end
   * after `CONTROL_LOCK_MS`; one that ends so, or a deadlock, is reported as
   * `CONFLICT` (nothing changed; try again), never as the raw database error.
   */
  private async controlled<T>(fn: (query: Query) => Promise<T>): Promise<T> {
    try { return await inTransaction(this.pool, db => fn(db.query.bind(db)), control()); } catch (error) {
      if (busy(error)) throw new AuthorityError('CONFLICT', 'The generations are in use by another operation; try again', undefined, true);
      throw error;
    }
  }

  /** Take the scope fence, refusing a closed space or collection, then allow control writes to wait for generation writers. */
  private async open(query: Query, spaceId: string, collectionId: string): Promise<void> {
    if (!await scopeOpen(query, spaceId, collectionId))
      throw new AuthorityError('SPACE_UNAVAILABLE', 'The space or collection is not open for projection');
    await query(`SET LOCAL lock_timeout = '${CONTROL_LOCK_MS}ms'`);
  }

  /** Under the scope fence, lock the collection's generations that are verifying, active or on standby. */
  private async lockStates(query: Query, spaceId: string, collectionId: string): Promise<Map<number, GenerationState>> {
    await this.open(query, spaceId, collectionId);
    return new Map((await query(`SELECT generation,state FROM projection_generations WHERE space_id=$1 AND collection_id=$2
      AND state IN ('verifying','active','standby') ORDER BY generation FOR UPDATE`, [spaceId, collectionId])).rows
      .map(row => [Number(row.generation), row.state]));
  }

  private async move(query: Query, spaceId: string, collectionId: string, generation: number | undefined, state: GenerationState) {
    if (generation !== undefined) await query(`UPDATE projection_generations SET state=$4 WHERE space_id=$1 AND collection_id=$2
      AND generation=$3`, [spaceId, collectionId, generation, state]);
  }
}
