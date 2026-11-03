import type pg from 'pg';
import type { Capability, VerifiedCredential } from '@stateplane/contracts';
import { CHUNK_CODE_POINTS, codePoints, embedBatch, EmbedderUnavailableError, EmbeddingRegistry, fuseRanks, pointer } from '@stateplane/retrieval';
import type { ActiveGeneration, CandidateScope, ChunkCandidate, Embedder, EmbedderIdentity, LexicalCandidates, RefKind,
  VectorCandidates } from '@stateplane/retrieval';
import { AuthorityError } from './index.js';
import type { AuthorityScope } from './index.js';
import type { ClaimEvidenceView, ClaimReviewStatus } from './claims.js';
import { within } from './faults.js';
import { FAILED_OUTBOX, LIVE_OUTBOX } from './outbox-sql.js';
import { boundedText, fields, invalid, iso, reference, transact, untrusted } from './sources.js';
import type { Db } from './sources.js';
import type { PostgresSpaces } from './spaces.js';

/** One cell's authority pool. */
export interface SearchCell { pool: Pick<pg.Pool, 'connect'> }
export interface SearchOptions {
  /** Configured embedders; without one for a generation's identity in an allowed region, its collection is searched lexically. */
  embedders?: EmbeddingRegistry;
}
export type SearchVectorState = 'used' | 'disabled' | 'unavailable';
export type SearchVectorError = 'EMBEDDER_NOT_CONFIGURED' | 'EMBEDDER_UNAVAILABLE' | 'EMBEDDER_FAILED' | 'VECTOR_QUERY_FAILED'
  | 'POLICY_CHANGED';
export type SearchProjectionState = 'current' | 'pending' | 'degraded' | 'unindexed';
export type SearchUnderfill = 'rejected' | 'bounded' | 'capped' | 'approximate' | 'exhausted' | 'degraded' | 'unindexed' | 'pending'
  | 'unprojected';
/** A code-point range of the authoritative text a hit matched in, read from authority, never from a projection. */
export interface SearchCitation {
  /** Every list whose best chunk for the Ref this is: lexical, vector or both. */
  matchedBy: ('lexical' | 'vector')[]; chunk: number; field: string | null; start: number; end: number;
  sourceStart: number | null; sourceEnd: number | null; text: string;
}
export interface SearchHit {
  ref: { spaceId: string; collectionId: string; kind: RefKind; id: string };
  /** The authoritative revision (and source extraction) the hit was built from and that authority still holds. */
  revision: number; extractionVersion: number | null;
  /** Reciprocal rank fusion score; comparable only within one result. */
  score: number;
  citations: SearchCitation[];
  provenance: {
    generation: number; policyVersion: number; lexicalRank: number | null; vectorRank: number | null;
    embedder: EmbedderIdentity | null; attributedTo: string | null; evidence: ClaimEvidenceView[];
  };
  /** A claim revision's review; null for records and sources. */
  review: { status: ClaimReviewStatus; reviewedBy: string | null; reviewedAt: string | null } | null;
  freshness: { verifiedAt: string; projection: Exclude<SearchProjectionState, 'unindexed'> };
}
export interface SearchCollection {
  collectionId: string; generation: number | null; lexical: boolean; vector: SearchVectorState;
  vectorError: SearchVectorError | null; projection: SearchProjectionState;
  /**
   * The requested kinds the caller may read here that no candidate list
   * covered: every one when no list ran over the collection (no active
   * generation, or no lexical side and no vector side used), otherwise those
   * the active generation's policy does not project.
   */
  unsearched: RefKind[];
}
/**
 * A ranked, reauthorized page of hits. It is never a complete answer: no
 * count, status or completeness follows from it. `underfill` is set when
 * fewer than `limit` hits survived, with every reason that applies.
 */
export interface SearchResult {
  spaceId: string; query: string; limit: number; mode: 'hybrid' | 'lexical'; state: 'current' | 'pending' | 'degraded';
  complete: false; results: SearchHit[];
  underfill: { returned: number; requested: number; reasons: SearchUnderfill[] } | null;
  candidates: { lexical: number; vector: number; considered: number };
  rejected: { deleted: number; stale: number; unauthorized: number };
  collections: SearchCollection[]; collectionsCapped: boolean;
}

/**
 * Initial protective bounds, not measured relevance or latency (STA-49
 * evaluates them): a query of at most 1,000 code points (what every
 * registered embedder accepts) and 4,000 bytes; up to 50 hits, 10 by
 * default; each candidate list fetches four times the limit, at least 20 and
 * at most 200; up to 32 collections per search; the query embeddings get one
 * try each, all of them within one 2 s budget.
 */
export const searchBounds = Object.freeze({ queryCodePoints: CHUNK_CODE_POINTS, queryBytes: 4_000, limit: 50, defaultLimit: 10,
  overfetchFactor: 4, minOverfetch: 20, maxOverfetch: 200, collections: 32, embedMs: 2_000 });
// Status samples at most this many due rows per queue, as the worker's status does.
const STATUS_SAMPLE = 500;
const KINDS: readonly RefKind[] = Object.freeze(['record', 'source', 'claim']);
const READ: Readonly<Record<RefKind, Capability>> = Object.freeze({ record: 'records:read', source: 'sources:read', claim: 'claims:read' });
const requestFields = Object.freeze(['query', 'collections', 'kinds', 'limit']);

interface Planned {
  collectionId: string;
  /** The kinds the caller asked for and may read here. */
  kinds: RefKind[];
  /** Of those, the kinds the active generation's policy projects into no list (every one when it enables neither list). */
  unprojected: RefKind[];
  /** The active generation, with the kinds the caller asked for and may read, and its vector identity when vectors are on. */
  active: (ActiveGeneration & { policyVersion: number; lexical: boolean; identity: EmbedderIdentity | null; regions: string[];
    /** Whether its dimension is searched exactly (no ANN index; `vector_index_strategies`), so a short vector list is complete. */
    exact: boolean }) | null;
  projection: SearchProjectionState; vector: SearchVectorState; vectorError: SearchVectorError | null;
}
interface Request { query: string; collections: string[] | null; kinds: RefKind[]; limit: number }

/** A plain array of distinct strings, read by own index, each accepted by `valid`. */
function strings(value: unknown, max: number, valid: (item: unknown) => boolean, name: string): string[] {
  if (!value || typeof value !== 'object' || untrusted(value) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype) invalid(`${name} must be an array`);
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
  if (length < 1 || length > max || Reflect.ownKeys(value).length !== length + 1) invalid(`${name} must hold 1 to ${max} items`);
  const items: string[] = [];
  for (let i = 0; i < length; i++) {
    const item = Object.getOwnPropertyDescriptor(value, i);
    if (!item?.enumerable || !Object.hasOwn(item, 'value') || !valid(item.value)) invalid(`Invalid ${name}`);
    if (!items.includes(item.value as string)) items.push(item.value as string);
  }
  return items;
}

function parse(request: unknown): Request {
  const input = fields(request, requestFields, ['query']);
  const query = input.query;
  if (!boundedText(query, searchBounds.queryBytes) || codePoints(query).length > searchBounds.queryCodePoints || !query.trim())
    invalid('query must be nonblank text of at most 1,000 code points and 4,000 bytes');
  const collections = input.collections === undefined ? null
    : strings(input.collections, searchBounds.collections, reference, 'collections');
  const kinds = input.kinds === undefined ? [...KINDS]
    : strings(input.kinds, KINDS.length, kind => KINDS.includes(kind as RefKind), 'kinds') as RefKind[];
  const limit = input.limit === undefined ? searchBounds.defaultLimit : input.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > searchBounds.limit)
    invalid(`limit must be an integer from 1 to ${searchBounds.limit}`);
  return { query, collections, kinds, limit: limit as number };
}

const overfetch = (limit: number) => Math.min(searchBounds.maxOverfetch, Math.max(searchBounds.minOverfetch,
  limit * searchBounds.overfetchFactor));
const refKey = (candidate: Pick<ChunkCandidate, 'collectionId' | 'kind' | 'id'>) =>
  JSON.stringify([candidate.collectionId, candidate.kind, candidate.id]);
const candidateColumns = `collection_id,ref_kind,ref_id,revision,extraction_version,generation,policy_version,chunk_index,field,
  content_start,content_end,source_start,source_end`;
function candidate(row: Record<string, unknown>): ChunkCandidate {
  const number = (value: unknown) => value === null ? null : Number(value);
  return { collectionId: String(row.collection_id), kind: row.ref_kind as RefKind, id: String(row.ref_id),
    revision: Number(row.revision), extractionVersion: number(row.extraction_version), generation: Number(row.generation),
    policyVersion: Number(row.policy_version), chunk: Number(row.chunk_index), field: row.field as string | null,
    start: Number(row.content_start), end: Number(row.content_end), sourceStart: number(row.source_start),
    sourceEnd: number(row.source_end), score: Number(row.score) };
}
/** The scope's generations as parallel arrays: collection, generation, kinds (comma-joined), text search configuration. */
const scopeArrays = (scope: CandidateScope) => [scope.generations.map(entry => entry.collectionId),
  scope.generations.map(entry => entry.generation), scope.generations.map(entry => entry.kinds.join(',')),
  scope.generations.map(entry => entry.textSearchConfig)];
/**
 * The claim read rule over a row with `space_id`, `collection_id`, `ref_kind`
 * and `ref_id`: not a claim, or a claim citing only live collections in
 * `evidence` (every live one when null).
 */
const claimVisible = (row: string, evidence: string) => `(${row}.ref_kind<>'claim' OR NOT EXISTS (SELECT 1 FROM claim_evidence a
    LEFT JOIN collections k ON k.space_id=a.space_id AND k.collection_id=a.source_collection_id
    WHERE a.space_id=${row}.space_id AND a.collection_id=${row}.collection_id AND a.claim_id=${row}.ref_id
      AND (k.collection_id IS NULL OR k.lifecycle='deleted'
        OR (${evidence}::text[] IS NOT NULL AND a.source_collection_id<>ALL(${evidence}::text[])))))`;
/**
 * Only chunks of what the caller could read when the candidates are read: in
 * a live collection, the Ref live at the chunk's revision (and, for a source,
 * its latest extraction), and a claim citing only live collections in
 * `evidence` (every live one when null). Deleted, superseded and hidden
 * content then leaves no trace in a candidate list, its counts or its ranks;
 * the reread still checks everything.
 */
const readable = (chunk: string, evidence: string) => `AND EXISTS (SELECT 1 FROM collections lc WHERE lc.space_id=${chunk}.space_id
    AND lc.collection_id=${chunk}.collection_id AND lc.lifecycle<>'deleted')
  AND CASE ${chunk}.ref_kind
    WHEN 'record' THEN EXISTS (SELECT 1 FROM records r WHERE r.space_id=${chunk}.space_id AND r.collection_id=${chunk}.collection_id
      AND r.record_id=${chunk}.ref_id AND r.revision=${chunk}.revision AND NOT r.tombstone)
    ELSE EXISTS (SELECT 1 FROM entity_refs e WHERE e.space_id=${chunk}.space_id AND e.collection_id=${chunk}.collection_id
      AND e.kind=${chunk}.ref_kind AND e.entity_id=${chunk}.ref_id AND e.revision=${chunk}.revision AND NOT e.tombstone) END
  AND (${chunk}.ref_kind<>'source' OR ${chunk}.extraction_version=(SELECT max(x.version) FROM extraction_versions x
    WHERE x.space_id=${chunk}.space_id AND x.collection_id=${chunk}.collection_id AND x.source_id=${chunk}.ref_id))
  AND ${claimVisible(chunk, evidence)}`;

/** One transaction whose statements all read the snapshot of its first query: `read`, then `observe`. */
async function snapshot<T>(pool: Pick<pg.Pool, 'connect'>, observe: ((db: Db) => Promise<void>) | undefined,
  read: (db: Db) => Promise<T>): Promise<T> {
  return transact(pool, async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const result = await read(db);
    await observe?.(db);
    return result;
  });
}

/**
 * The lexical and vector candidate ports over PostgreSQL full-text search
 * and pgvector. Each call is one short REPEATABLE READ transaction of its
 * own, reading only the given active generations and, in each, only the kinds
 * it lists; `observe`, run after the candidates in that transaction, reads
 * the same snapshot. Candidates are pointers for a reread, never results.
 */
export class PostgresCandidates implements LexicalCandidates, VectorCandidates {
  constructor(private readonly pool: Pick<pg.Pool, 'connect'>) {}

  /**
   * Chunks whose `tsvector` matches the query under each generation's own
   * text search configuration (`websearch_to_tsquery`), ranked by
   * `ts_rank_cd`; each Ref's best chunk, best first.
   */
  async lexical(scope: CandidateScope, query: string, limit: number, observe?: (db: Db) => Promise<void>)
    : Promise<ChunkCandidate[]> {
    if (!scope.generations.length) return [];
    return snapshot(this.pool, observe, async db => (await db.query(`WITH m AS (
        SELECT l.${candidateColumns.replaceAll(',', ',l.')},ts_rank_cd(l.tsv,q.query)::float8 AS score
        FROM unnest($2::text[],$3::bigint[],$4::text[],$5::text[]) AS a(collection_id,generation,kinds,config)
        CROSS JOIN LATERAL (SELECT websearch_to_tsquery(('pg_catalog.' || a.config)::regconfig,$6) AS query) q
        JOIN lexical_chunks l ON l.space_id=$1 AND l.collection_id=a.collection_id AND l.generation=a.generation
          AND l.ref_kind=ANY(string_to_array(a.kinds,',')) AND l.tsv @@ q.query ${readable('l', '$8')}),
      best AS (SELECT DISTINCT ON (collection_id,ref_kind,ref_id) * FROM m
        ORDER BY collection_id,ref_kind,ref_id,score DESC,chunk_index)
      SELECT * FROM best ORDER BY score DESC,collection_id COLLATE "C",ref_kind,ref_id COLLATE "C" LIMIT $7`,
    [scope.spaceId, ...scopeArrays(scope), query, limit, scope.evidenceCollections])).rows.map(candidate));
  }

  /**
   * The nearest chunks by cosine distance, through the dimension's HNSW
   * partial index where it has one (exact otherwise), with `hnsw.ef_search`
   * raised to `limit` and pgvector's strict-order iterative scan, so a scope
   * filter makes the index scan further instead of returning fewer rows.
   * An HNSW scan is still approximate: never complete recall.
   */
  async nearest(scope: CandidateScope, identity: EmbedderIdentity, embedding: readonly number[], limit: number,
    observe?: (db: Db) => Promise<void>): Promise<ChunkCandidate[]> {
    const dimensions = identity.dimensions;
    if (!Number.isSafeInteger(dimensions) || dimensions < 1 || embedding.length !== dimensions || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 1_000) throw new RangeError('Invalid vector search');
    if (!scope.generations.length) return [];
    // The cast and `dimensions` literal are what the partial index is defined with; both are checked integers.
    const distance = `(v.embedding::vector(${dimensions})) <=> $6::vector(${dimensions})`;
    return snapshot(this.pool, observe, async db => {
      await db.query(`SET LOCAL hnsw.ef_search = ${limit}`);
      await db.query(`SET LOCAL hnsw.iterative_scan = strict_order`);
      return (await db.query(`SELECT x.* FROM unnest($2::text[],$3::bigint[],$4::text[],$5::text[])
          AS a(collection_id,generation,kinds,config)
        CROSS JOIN LATERAL (SELECT v.${candidateColumns.replaceAll(',', ',v.')},1-(${distance}) AS score FROM vector_chunks v
          WHERE v.space_id=$1 AND v.collection_id=a.collection_id AND v.generation=a.generation AND v.dimensions=${dimensions}
            AND v.embedder=$7 AND v.embedding_model=$8 AND v.model_version=$9 AND v.ref_kind=ANY(string_to_array(a.kinds,','))
            ${readable('v', '$11')}
          ORDER BY ${distance} LIMIT $10) x
        ORDER BY x.score DESC,x.collection_id COLLATE "C",x.ref_kind,x.ref_id COLLATE "C",x.chunk_index LIMIT $10`,
      [scope.spaceId, ...scopeArrays(scope), `[${embedding.join(',')}]`, identity.embedder, identity.model, identity.modelVersion,
        limit, scope.evidenceCollections])).rows.map(candidate);
    });
  }
}

/**
 * Plan a search: the caller's readable collections in the space (optionally
 * only `wanted`), at most one more than the cap, each with the kinds it may
 * read, its active generation with its policy and the regions both policies
 * allow, and its projection state over only the work the caller could see:
 * of the kinds searched there, and claims under the read rule (`evidence`).
 * A plan only chooses what to read; the reread decides what is returned.
 */
async function plan(db: Db, scope: AuthorityScope, owner: boolean, request: Request, evidence: string[] | null)
  : Promise<Planned[]> {
  const capabilities = request.kinds.map(kind => READ[kind]);
  const rows = (await db.query(`SELECT c.collection_id,g.capabilities,a.generation,a.policy_version,p.lexical,p.vector,
      p.text_search_config,cardinality(p.record_fields)>0 AS records_projected,p.source_content,p.claim_statements,a.embedder,a.embedding_model,a.model_version,a.dimensions,
      s.method='exact' AS exact,
      ARRAY(SELECT r FROM unnest(cur.processing_regions) WITH ORDINALITY u(r,n) WHERE r=ANY(p.processing_regions) ORDER BY n) AS regions
    FROM collections c
    LEFT JOIN collection_grants g ON NOT $3 AND g.space_id=c.space_id AND g.collection_id=c.collection_id AND g.credential_id=$2
      AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
    LEFT JOIN projection_generations a ON a.space_id=c.space_id AND a.collection_id=c.collection_id AND a.state='active'
    LEFT JOIN retrieval_policies p ON p.space_id=a.space_id AND p.collection_id=a.collection_id AND p.version=a.policy_version
    LEFT JOIN retrieval_collection_heads h ON h.space_id=a.space_id AND h.collection_id=a.collection_id
    LEFT JOIN retrieval_policies cur ON cur.space_id=h.space_id AND cur.collection_id=h.collection_id AND cur.version=h.policy_version
    LEFT JOIN vector_index_strategies s ON s.dimensions=a.dimensions
    WHERE c.space_id=$1 AND c.lifecycle<>'deleted' AND ($4::text[] IS NULL OR c.collection_id=ANY($4::text[]))
      AND ($3 OR g.capabilities && $5::text[])
    ORDER BY c.collection_id COLLATE "C" LIMIT $6`,
  [scope.spaceId, scope.credentialId, owner, request.collections, capabilities, searchBounds.collections + 1])).rows;
  const planned: Planned[] = rows.map(row => {
    const kinds = request.kinds.filter(kind => owner || (row.capabilities as string[]).includes(READ[kind]));
    const vector = row.vector === true && row.embedder !== null;
    // What the generation's policy makes searchable: a kind it projects, through a list it enables.
    const projects: Record<RefKind, boolean> = { record: row.records_projected === true, source: row.source_content === true,
      claim: row.claim_statements === true };
    const unprojected = row.generation === null ? []
      : kinds.filter(kind => !projects[kind] || (row.lexical !== true && !vector));
    return { collectionId: String(row.collection_id), kinds, unprojected,
      active: row.generation === null ? null : { collectionId: String(row.collection_id), generation: Number(row.generation), kinds,
        policyVersion: Number(row.policy_version), textSearchConfig: String(row.text_search_config), lexical: row.lexical === true,
        regions: row.regions as string[], exact: row.exact === true, identity: vector ? { embedder: row.embedder, model: row.embedding_model,
          modelVersion: row.model_version, dimensions: Number(row.dimensions) } : null },
      projection: row.generation === null ? 'unindexed' : 'current', vector: vector ? 'unavailable' : 'disabled', vectorError: null };
  });
  observeStates(planned, await projectionStates(db, scope.spaceId, planned, evidence));
  return planned;
}

/**
 * The projection state of each planned collection with an active generation,
 * over only the work the caller could see: of the kinds searched there, and
 * claims under the read rule (`evidence`). The plan, each candidate list (in
 * its own snapshot) and the reread all read it; `observeStates` keeps the
 * worst, so coverage holds only if it held wherever the candidates were read.
 */
async function projectionStates(db: Db, spaceId: string, planned: readonly Planned[], evidence: readonly string[] | null)
  : Promise<Map<string, SearchProjectionState>> {
  const indexed = planned.filter(entry => entry.active);
  if (!indexed.length) return new Map();
  // Pending and degraded as the worker's status reports them, over the work of the searched (readable) kinds only:
  // record work (projection_outbox) only when records are searched; source and claim work by kind, a claim's only
  // under the claim read rule. Work waiting; a failure or error among the oldest-due such rows, or a failed record
  // delivery anywhere. Work the caller could not read therefore never shows. Exact reads never depend on this.
  const visible = `o.space_id=$1 AND o.collection_id=x.collection_id AND o.delivery_state='pending' AND o.ref_kind=ANY(x.kinds)
    AND ${claimVisible('o', '$5')}`;
  return new Map((await db.query(`SELECT x.collection_id,
      ('record'=ANY(x.kinds) AND EXISTS (SELECT 1 FROM projection_outbox WHERE space_id=$1 AND collection_id=x.collection_id
          AND ${LIVE_OUTBOX}))
        OR EXISTS (SELECT 1 FROM retrieval_outbox o WHERE ${visible}) AS pending,
      ('record'=ANY(x.kinds) AND (EXISTS (SELECT 1 FROM projection_outbox WHERE space_id=$1 AND collection_id=x.collection_id
          AND ${FAILED_OUTBOX})
        OR EXISTS (SELECT 1 FROM (SELECT last_error FROM projection_outbox WHERE space_id=$1 AND collection_id=x.collection_id
          AND ${LIVE_OUTBOX} ORDER BY available_at,event_id LIMIT $4) s WHERE s.last_error IS NOT NULL)))
        OR EXISTS (SELECT 1 FROM (SELECT o.last_error FROM retrieval_outbox o WHERE ${visible}
          ORDER BY o.available_at,o.job_id LIMIT $4) s WHERE s.last_error IS NOT NULL) AS degraded
    FROM unnest($2::text[],$3::text[]) AS u(collection_id,kinds)
    CROSS JOIN LATERAL (SELECT u.collection_id,string_to_array(u.kinds,',') AS kinds) x`,
  [spaceId, indexed.map(entry => entry.collectionId), indexed.map(entry => entry.active!.kinds.join(',')), STATUS_SAMPLE,
    evidence])).rows.map(row => {
    let state: SearchProjectionState = 'current';
    if (row.degraded) state = 'degraded';
    else if (row.pending) state = 'pending';
    return [String(row.collection_id), state] as const;
  }));
}

const SEVERITY: Readonly<Record<SearchProjectionState, number>> = Object.freeze({ current: 0, pending: 1, degraded: 2,
  unindexed: 3 });
/** Fold one coverage observation into each collection's state; a later, better one never overwrites an earlier, worse one. */
function observeStates(planned: readonly Planned[], states: ReadonlyMap<string, SearchProjectionState>): void {
  for (const entry of planned) {
    const seen = states.get(entry.collectionId);
    if (entry.active && seen && SEVERITY[seen] > SEVERITY[entry.projection]) entry.projection = seen;
  }
}

/**
 * The live collections whose sources a key may read now (null for the owner,
 * who reads every live one): a claim citing any other is no candidate.
 */
async function evidenceCollections(db: Db, scope: AuthorityScope, owner: boolean): Promise<string[] | null> {
  if (owner) return null;
  return (await db.query(`SELECT g.collection_id FROM collection_grants g
      JOIN collections c ON c.space_id=g.space_id AND c.collection_id=g.collection_id
    WHERE g.space_id=$1 AND g.credential_id=$2 AND c.lifecycle<>'deleted' AND 'sources:read'=ANY(g.capabilities)
      AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) ORDER BY g.collection_id COLLATE "C"`,
  [scope.spaceId, scope.credentialId])).rows.map(row => String(row.collection_id));
}

/** One candidate citation as authority holds it now. */
interface Reread {
  currentRevision: number | null; tombstone: boolean | null; latestExtraction: number | null;
  /** The cited range only, or null when authority's text no longer reaches the citation's end. */
  text: string | null;
  /** A record whose `jsonb` cannot hold its text (U+0000): its cited range is read from its canonical JSON on demand. */
  canonical: boolean;
  review: SearchHit['review']; attributedTo: string | null; evidence: ClaimEvidenceView[]; cited: string[]; verifiedAt: string;
}

/**
 * Reread every candidate citation at authority in one statement, so all of
 * them come from one snapshot: the Ref's current revision and tombstone, a
 * source's latest extraction, the cited range of the record field,
 * extraction or claim revision the chunk was built from (sliced by code
 * point in SQL, so only the range leaves the database), a claim revision's
 * review, attribution and evidence, and every collection any revision of the
 * claim cites (whose liveness `citedCollections` decides under its locks).
 */
async function reread(db: Db, spaceId: string, candidates: readonly ChunkCandidate[]): Promise<Reread[]> {
  const column = <T>(pick: (item: ChunkCandidate) => T) => candidates.map(pick);
  const path = (field: string | null) => field === null ? null
    : JSON.stringify(field.split('/').slice(1).map(token => token.replaceAll('~1', '/').replaceAll('~0', '~')));
  const rows = (await db.query(`SELECT c.n,clock_timestamp() AS verified_at,COALESCE(rec.revision,e.revision) AS current_revision,
      COALESCE(rec.tombstone,e.tombstone) AS tombstone,x.latest,
      CASE WHEN char_length(w.whole)>=c.finish THEN substr(w.whole,(c.start+1)::int,(c.finish-c.start)::int) END AS text,
      (c.kind='record' AND rec.record_id IS NOT NULL AND rec.data IS NULL) AS canonical,
      cr.review_status,cr.reviewed_by,cr.reviewed_at,cr.attributed_to,
      CASE WHEN c.kind='claim' THEN COALESCE((SELECT jsonb_agg(jsonb_build_array(v.source_collection_id,v.source_id,
          v.extraction_version,v.start_offset,v.end_offset) ORDER BY v.ordinal) FROM claim_evidence v WHERE v.space_id=$1
        AND v.collection_id=c.collection_id AND v.claim_id=c.id AND v.revision=c.revision),'[]'::jsonb) END AS evidence,
      ARRAY(SELECT DISTINCT a.source_collection_id FROM claim_evidence a WHERE c.kind='claim' AND a.space_id=$1
        AND a.collection_id=c.collection_id AND a.claim_id=c.id) AS cited
    FROM unnest($2::text[],$3::text[],$4::text[],$5::bigint[],$6::bigint[],$7::jsonb[],$8::bigint[],$9::bigint[]) WITH ORDINALITY
      AS c(collection_id,kind,id,revision,extraction_version,path,start,finish,n)
    LEFT JOIN records rec ON c.kind='record' AND rec.space_id=$1 AND rec.collection_id=c.collection_id AND rec.record_id=c.id
    LEFT JOIN entity_refs e ON c.kind<>'record' AND e.space_id=$1 AND e.collection_id=c.collection_id AND e.kind=c.kind
      AND e.entity_id=c.id
    LEFT JOIN LATERAL (SELECT max(v.version) AS latest FROM extraction_versions v WHERE c.kind='source' AND v.space_id=$1
      AND v.collection_id=c.collection_id AND v.source_id=c.id) x ON true
    LEFT JOIN extraction_versions ev ON c.kind='source' AND ev.space_id=$1 AND ev.collection_id=c.collection_id
      AND ev.source_id=c.id AND ev.version=c.extraction_version
    LEFT JOIN claim_revisions cr ON c.kind='claim' AND cr.space_id=$1 AND cr.collection_id=c.collection_id AND cr.claim_id=c.id
      AND cr.revision=c.revision
    CROSS JOIN LATERAL (SELECT CASE c.kind WHEN 'record' THEN rec.data #>> ARRAY(SELECT jsonb_array_elements_text(c.path))
      WHEN 'source' THEN ev.content ELSE cr.statement END AS whole) w
    ORDER BY c.n`,
  [spaceId, column(item => item.collectionId), column(item => item.kind), column(item => item.id), column(item => item.revision),
    column(item => item.extractionVersion), column(item => path(item.field)), column(item => item.start),
    column(item => item.end)])).rows;
  return rows.map(row => ({ currentRevision: row.current_revision === null ? null : Number(row.current_revision),
    tombstone: row.tombstone, latestExtraction: row.latest === null ? null : Number(row.latest), text: row.text ?? null,
    canonical: row.canonical === true,
    review: row.review_status ? { status: row.review_status, reviewedBy: row.reviewed_by, reviewedAt: iso(row.reviewed_at) } : null,
    attributedTo: row.attributed_to ?? null, cited: row.cited, verifiedAt: iso(row.verified_at)!,
    evidence: ((row.evidence ?? []) as unknown[][]).map(item => ({ collectionId: String(item[0]), sourceId: String(item[1]),
      extractionVersion: item[2] === null ? null : Number(item[2]), start: item[3] === null ? null : Number(item[3]),
      end: item[4] === null ? null : Number(item[4]) })) }));
}

/**
 * The cited range of a record whose `jsonb` cannot hold its text, from its
 * canonical JSON at the candidate's revision. Read one record at a time and
 * only for a page hit, so at most `limit` records' canonical JSON (each at
 * most 1 MiB), plus one per citation found no longer to hold, is read, one
 * after another.
 */
async function canonicalRange(db: Db, spaceId: string, candidate: ChunkCandidate): Promise<string | null> {
  const row = (await db.query(`SELECT canonical_data FROM records WHERE space_id=$1 AND collection_id=$2 AND record_id=$3
    AND revision=$4 AND NOT tombstone AND data IS NULL`, [spaceId, candidate.collectionId, candidate.id, candidate.revision])).rows[0];
  if (!row) return null;
  const value = pointer(JSON.parse(row.canonical_data), candidate.field ?? '');
  // Code points of the authoritative text, as every projection offset counts them.
  const points = typeof value === 'string' ? codePoints(value) : null;
  return points && points.length >= candidate.end ? points.slice(candidate.start, candidate.end).join('') : null;
}

/**
 * Whether authority still holds the exact revision (and extraction) a
 * citation was built from, with its text (a canonical-JSON record's is read
 * only when the citation is about to be returned, and checked then).
 */
const holds = (candidate: ChunkCandidate, read: Reread) => read.tombstone === false && read.currentRevision === candidate.revision
  && (read.text !== null || read.canonical) && (candidate.kind !== 'source' || read.latestExtraction === candidate.extractionVersion);

/** What the caller may read now, under the locks `lockScope` holds. */
interface Access { owner: boolean; grants: Map<string, readonly string[]> }
const mayRead = (access: Access, collectionId: string, capability: string) =>
  access.grants.get(collectionId)?.includes(capability) === true;

/**
 * Every grant a key's response depends on, as `[collection, capability]`
 * pairs: each plan row's read capability for every kind searched (or
 * reported) there, the cap witness's included, and, when claims are
 * searched, `sources:read` on every collection the claim filter treated as
 * readable. Candidates, counts, ranks,
 * collection status and underfill all follow from these, whatever the page
 * holds; the reread's locks compare them with the plan, and the final check
 * confirms them (with each page claim's cited collections) through commit.
 */
function dependencies(planned: readonly Planned[], evidence: readonly string[] | null): Set<string> {
  const pairs = new Set<string>();
  for (const entry of planned) for (const kind of entry.kinds) pairs.add(JSON.stringify([entry.collectionId, READ[kind]]));
  if (evidence !== null && planned.some(entry => entry.active?.kinds.includes('claim')))
    for (const id of evidence) pairs.add(JSON.stringify([id, 'sources:read']));
  return pairs;
}
const pairsOf = (relied: ReadonlySet<string>) => [...relied].map(pair => JSON.parse(pair) as [string, string]);

interface Group { identity: EmbedderIdentity; embedder: Embedder; entries: Planned[] }

/** Thrown by a group's admission when none of its collections may still send the query to its embedder. */
class AdmissionClosed extends Error {}

/**
 * Each collection's active generation now, with its policy version and the
 * regions both that policy and the collection's current one allow, read
 * just before a query embedding call; empty when the space is no longer open
 * at the admitted policy and placement. Live collections only.
 */
async function admission(db: Db, scope: AuthorityScope, collectionIds: string[])
  : Promise<Map<string, { generation: number; policyVersion: number; regions: string[] }>> {
  const rows = (await db.query(`SELECT a.collection_id,a.generation,a.policy_version,
      ARRAY(SELECT r FROM unnest(cur.processing_regions) WITH ORDINALITY u(r,n) WHERE r=ANY(p.processing_regions) ORDER BY n) AS regions
    FROM spaces s JOIN collections c ON c.space_id=s.space_id
    JOIN projection_generations a ON a.space_id=c.space_id AND a.collection_id=c.collection_id AND a.state='active'
    JOIN retrieval_policies p ON p.space_id=a.space_id AND p.collection_id=a.collection_id AND p.version=a.policy_version
    JOIN retrieval_collection_heads h ON h.space_id=a.space_id AND h.collection_id=a.collection_id
    JOIN retrieval_policies cur ON cur.space_id=h.space_id AND cur.collection_id=h.collection_id AND cur.version=h.policy_version
    WHERE s.space_id=$1 AND s.lifecycle IN ('active','readOnly') AND s.policy_version=$2 AND s.placement_generation=$3
      AND c.lifecycle<>'deleted' AND c.collection_id=ANY($4::text[])`,
  [scope.spaceId, scope.policyVersion, scope.placementGeneration, collectionIds])).rows;
  return new Map(rows.map(row => [String(row.collection_id), { generation: Number(row.generation),
    policyVersion: Number(row.policy_version), regions: row.regions as string[] }]));
}

/**
 * The searched collections' active generations, share locked through commit
 * after the scope locks, so a cutover either committed before the reread and
 * is seen, or waits for the search to commit. A hit from any other
 * generation (or policy version) is stale.
 */
async function activeGenerations(db: Db, spaceId: string, collectionIds: string[])
  : Promise<Map<string, { generation: number; policyVersion: number }>> {
  const rows = (await db.query(`SELECT collection_id,generation,policy_version FROM projection_generations
    WHERE space_id=$1 AND collection_id=ANY($2::text[]) AND state='active' ORDER BY collection_id COLLATE "C" FOR SHARE`,
  [spaceId, collectionIds])).rows;
  return new Map(rows.map(row => [String(row.collection_id), { generation: Number(row.generation),
    policyVersion: Number(row.policy_version) }]));
}

/**
 * Every collection the reread claims cite, share locked through commit after
 * the scope and generation locks, in one fixed order, for the owner and keys
 * alike, as the claim read rule's fence does: a collection deletion either
 * committed before, and is seen here, or waits for the search to commit. The
 * live ones; liveness is decided from these locked rows only.
 */
async function citedCollections(db: Db, spaceId: string, collectionIds: string[]): Promise<Set<string>> {
  if (!collectionIds.length) return new Set();
  const rows = (await db.query(`SELECT collection_id,lifecycle FROM collections WHERE space_id=$1 AND collection_id=ANY($2::text[])
    ORDER BY collection_id COLLATE "C" FOR SHARE`, [spaceId, collectionIds])).rows;
  return new Set(rows.filter(row => row.lifecycle !== 'deleted').map(row => String(row.collection_id)));
}

/**
 * Hybrid search over each granted collection's active projection generation.
 * Lexical and vector candidates are fused by reciprocal rank, deduplicated by
 * canonical Ref and overfetched within a bound; every candidate is then
 * reread at authority and reauthorized in a fresh transaction, so a deleted,
 * revoked, unauthorized or stale hit is never returned. When the embedder or
 * vector query is unavailable, a collection is searched lexically and the
 * result says so. Exact reads and writes never depend on search.
 */
export class PostgresRetrievalSearch {
  readonly #embedders: EmbeddingRegistry;
  constructor(private readonly spaces: PostgresSpaces, private readonly cells: ReadonlyMap<string, SearchCell>,
    options: SearchOptions = {}) {
    const embedders = options.embedders ?? new EmbeddingRegistry();
    if (!(embedders instanceof EmbeddingRegistry)) throw new RangeError('Invalid embedder registry');
    this.#embedders = embedders;
  }

  /**
   * Search `spaceId` for `request.query`: `{ query, collections?, kinds?, limit? }`.
   * Without `collections`, every collection the caller may read for one of
   * `kinds` (records `records:read`, sources `sources:read`, claims
   * `claims:read`), up to the collection bound; a listed collection the
   * caller cannot read for any of them, or that does not exist, is NOT_FOUND.
   */
  async search(actor: VerifiedCredential, spaceId: string, request: unknown): Promise<SearchResult> {
    const admitted = await this.spaces.scope(actor, spaceId, undefined, 'records:read');
    const cell = this.cells.get(admitted.cellId);
    if (!cell) throw new AuthorityError('STALE_PLACEMENT');
    const { scope, ownerPrincipalId } = admitted;
    const owner = actor.kind === 'session';
    const input = parse(request);
    const { all, evidence } = await transact(cell.pool, async db => {
      const evidence = await evidenceCollections(db, scope, owner);
      return { all: await plan(db, scope, owner, input, evidence), evidence };
    });
    const collectionsCapped = all.length > searchBounds.collections;
    const planned = all.slice(0, searchBounds.collections);
    if (input.collections && planned.length !== input.collections.length) throw new AuthorityError('NOT_FOUND');
    if (!owner && !planned.length) throw new AuthorityError('FORBIDDEN');
    const bound = overfetch(input.limit);
    const candidates = new PostgresCandidates(cell.pool);
    const scopeOf = (entries: Planned[]): CandidateScope => ({ spaceId, generations: entries.map(entry => entry.active!),
      evidenceCollections: evidence });
    const observe = (entries: Planned[]) => async (db: Db) =>
      observeStates(entries, await projectionStates(db, spaceId, entries, evidence));
    // Every plan row, the cap witness included: `collectionsCapped` follows from it as the rest follows from the searched ones.
    const relied = dependencies(all, evidence);

    // One embedding per identity and region, sent only to a region both of each collection's policies allow.
    const groups = new Map<string, Group>();
    for (const entry of planned) {
      const identity = entry.active?.identity;
      if (!identity) continue;
      const embedder = this.#embedders.resolve(identity, entry.active!.regions, codePoints(input.query).length);
      if (!embedder) { entry.vectorError = 'EMBEDDER_NOT_CONFIGURED'; continue; }
      const key = JSON.stringify([identity.embedder, identity.model, identity.modelVersion, identity.dimensions, embedder.profile.region]);
      const group = groups.get(key) ?? { identity, embedder, entries: [] };
      group.entries.push(entry);
      groups.set(key, group);
    }
    const vectorLists: ChunkCandidate[][] = [];
    // A filtered approximate (HNSW) scan can stop short (pgvector's hnsw.max_scan_tuples), so its short list proves
    // nothing; an exact scan's short list holds every chunk it could reach.
    let approximate = false;
    // One budget for every group's embedding call, so stalled providers cannot multiply the wait before lexical answers.
    const vectorEnd = performance.now() + searchBounds.embedMs;
    for (const { identity, embedder, entries } of groups.values()) {
      const left = Math.floor(vectorEnd - performance.now());
      if (left <= 0) {
        for (const entry of entries) entry.vectorError = 'EMBEDDER_UNAVAILABLE';
        continue;
      }
      let embedding: number[];
      let admitted: Planned[] = [];
      let stage: 'admission' | 'embedding' = 'admission';
      let denied: unknown = null;
      // Just before the call, in a fresh read: the caller's credential (at the provider) and every grant the search
      // relies on still current, the space still open at the admitted policy and placement, and each collection live at
      // the planned active generation with the embedder's region allowed by both policies. A lapse or narrowing
      // committed during an earlier group's call therefore stops this one; one committed during this call cannot recall
      // it, as for the worker.
      const admit = async () => {
        const current = await transact(cell.pool, async db => {
          try { await this.assertCurrent(db, actor, ownerPrincipalId, scope, relied); }
          catch (error) { if (error instanceof AuthorityError) denied = error; throw error; }
          return admission(db, scope, entries.map(entry => entry.collectionId));
        });
        // A read that outlasted the budget changes nothing: the group was already reported unavailable.
        if (signal.aborted) throw new AdmissionClosed();
        admitted = entries.filter(entry => {
          const now = current.get(entry.collectionId);
          return now !== undefined && now.generation === entry.active!.generation && now.policyVersion === entry.active!.policyVersion
            && now.regions.includes(embedder.profile.region);
        });
        for (const entry of entries) if (!admitted.includes(entry)) entry.vectorError = 'POLICY_CHANGED';
        if (!admitted.length) throw new AdmissionClosed();
        stage = 'embedding';
      };
      // One try; a call that outlasts the budget, even one ignoring its signal, is an outage and is not waited for.
      const signal = AbortSignal.timeout(left);
      try { [embedding] = await within(embedBatch(embedder, [input.query], signal, [], admit), signal); }
      catch (error) {
        if (denied) throw denied;
        if (error instanceof AdmissionClosed) continue;
        // The shared budget running out is an outage whatever stage it cut short.
        let code: SearchVectorError = stage === 'admission' ? 'VECTOR_QUERY_FAILED' : 'EMBEDDER_FAILED';
        if (signal.aborted || error instanceof EmbedderUnavailableError) code = 'EMBEDDER_UNAVAILABLE';
        for (const entry of stage === 'admission' ? entries : admitted) entry.vectorError = code;
        continue;
      }
      let list: ChunkCandidate[];
      try { list = await candidates.nearest(scopeOf(admitted), identity, embedding, bound, observe(admitted)); }
      catch { for (const entry of admitted) entry.vectorError = 'VECTOR_QUERY_FAILED'; continue; }
      vectorLists.push(list);
      if (list.length < bound && !entries[0].active!.exact) approximate = true;
      for (const entry of admitted) entry.vector = 'used';
    }
    const lexicalEntries = planned.filter(entry => entry.active?.lexical);
    const lexical = await candidates.lexical(scopeOf(lexicalEntries), input.query, bound, observe(lexicalEntries));

    // Fuse one list per source, each deduplicated to the Ref's best chunk, and consider at most `bound` Refs.
    const lists = [lexical, ...vectorLists].map(list => {
      const best = new Map<string, ChunkCandidate>();
      for (const hit of list) if (!best.has(refKey(hit))) best.set(refKey(hit), hit);
      return best;
    });
    const fused = fuseRanks(lists.map(list => [...list.keys()]));
    const considered = fused.slice(0, bound);
    const bounded = lexical.length >= bound || vectorLists.some(list => list.length >= bound) || fused.length > bound;
    // Each considered Ref's citations: its best chunk from every list it is in, lexical first.
    const cited = considered.map(entry => lists.flatMap((list, from) => {
      const hit = list.get(entry.key);
      return hit ? [{ from, hit }] : [];
    }));

    const { hits, rejected, deadline } = await transact(cell.pool, async db => {
      const access = await this.lockScope(db, scope, owner, planned.map(entry => entry.collectionId));
      // The candidates were read under the plan's access, so a key whose access narrowed since (a grant expired) could
      // have candidates, counts and ranks from content written after it lost access: fail closed instead.
      if (!owner && pairsOf(relied).some(([id, capability]) => !mayRead(access, id, capability)))
        throw new AuthorityError('FORBIDDEN', 'Access changed during search');
      const active = await activeGenerations(db, spaceId, planned.map(entry => entry.collectionId));
      // Coverage after every candidate read too, under the generation locks, folded into what the plan and each list's own
      // snapshot saw: the work visible now, and a collection whose active generation or policy moved since the plan was
      // not searched at what is active, so it is pending.
      observeStates(planned, await projectionStates(db, spaceId, planned, evidence));
      for (const entry of planned) {
        const now = active.get(entry.collectionId);
        const moved = now?.generation !== entry.active?.generation || now?.policyVersion !== entry.active?.policyVersion;
        if (entry.active && moved && entry.projection === 'current') entry.projection = 'pending';
      }
      const flat = cited.flat();
      const reads = flat.length ? await reread(db, spaceId, flat.map(item => item.hit)) : [];
      const readOf = new Map(flat.map((item, at) => [item, reads[at]]));
      const live = await citedCollections(db, spaceId, [...new Set(reads.flatMap(read => read.cited))]);
      const rejected = { deleted: 0, stale: 0, unauthorized: 0 };
      // Validate every considered Ref: only citations from the active generation of exactly what authority holds now
      // survive, and a Ref with none left is stale.
      const kept = new Map<string, { items: typeof cited[number]; read: Reread }>();
      for (let index = 0; index < considered.length; index++) {
        const head = cited[index][0].hit;
        if (!mayRead(access, head.collectionId, READ[head.kind])) { rejected.unauthorized++; continue; }
        const first = readOf.get(cited[index][0])!;
        if (first.currentRevision === null || first.tombstone !== false) { rejected.deleted++; continue; }
        const generation = active.get(head.collectionId);
        const items = cited[index].filter(item => generation?.generation === item.hit.generation
          && generation.policyVersion === item.hit.policyVersion && holds(item.hit, readOf.get(item)!));
        if (!items.length) { rejected.stale++; continue; }
        const read = readOf.get(items[0])!;
        // The claim read rule: a claim citing a collection whose sources the caller cannot read does not exist for it.
        if (head.kind === 'claim' && read.cited.some(id => !live.has(id) || (!access.owner && !mayRead(access, id, 'sources:read')))) {
          rejected.unauthorized++; continue;
        }
        kept.set(considered[index].key, { items, read });
      }
      // Fuse again over the surviving matches only, so a rejected or stale match neither ranks nor boosts a Ref, then take
      // the page. A canonical-JSON record's cited text is read only for a page hit; one that no longer holds drops its
      // citation and the page is fused again.
      let page: ReturnType<typeof fuseRanks>;
      for (;;) {
        page = fuseRanks(lists.map((list, from) => [...list.keys()]
          .filter(key => kept.get(key)?.items.some(item => item.from === from)))).slice(0, input.limit);
        let changed = false;
        for (const { key } of page) {
          const entry = kept.get(key)!;
          for (const item of entry.items) {
            const read = readOf.get(item)!;
            if (read.text !== null) continue;
            read.text = await canonicalRange(db, spaceId, item.hit);
            if (read.text === null) { read.canonical = false; changed = true; }
          }
          entry.items = entry.items.filter(item => readOf.get(item)!.text !== null);
          if (!entry.items.length) { kept.delete(key); rejected.stale++; }
        }
        if (!changed) break;
      }
      const hits: SearchHit[] = [];
      for (const { key, ranks, score } of page) {
        const { items, read } = kept.get(key)!;
        const chunk = items[0].hit;
        for (const id of chunk.kind === 'claim' ? read.cited : []) relied.add(JSON.stringify([id, 'sources:read']));
        const entry = planned.find(item => item.collectionId === chunk.collectionId)!;
        // One citation per chunk, naming every list that found it there.
        const citations: SearchCitation[] = [];
        for (const item of items) {
          const by = item.from === 0 ? 'lexical' as const : 'vector' as const;
          const same = citations.find(other => other.chunk === item.hit.chunk);
          if (same) { if (!same.matchedBy.includes(by)) same.matchedBy.push(by); continue; }
          citations.push({ matchedBy: [by], chunk: item.hit.chunk, field: item.hit.field, start: item.hit.start, end: item.hit.end,
            sourceStart: item.hit.sourceStart, sourceEnd: item.hit.sourceEnd, text: readOf.get(item)!.text! });
        }
        hits.push({ ref: { spaceId, collectionId: chunk.collectionId, kind: chunk.kind, id: chunk.id }, revision: chunk.revision,
          extractionVersion: chunk.extractionVersion, score, citations,
          provenance: { generation: chunk.generation, policyVersion: chunk.policyVersion, lexicalRank: ranks[0],
            vectorRank: ranks.slice(1).find(rank => rank !== null) ?? null,
            embedder: items.some(item => item.from > 0) ? entry.active!.identity : null,
            attributedTo: read.attributedTo, evidence: chunk.kind === 'claim' ? read.evidence : [] },
          review: chunk.kind === 'claim' ? read.review : null,
          freshness: { verifiedAt: read.verifiedAt, projection: entry.projection === 'unindexed' ? 'pending' : entry.projection } });
      }
      const deadline = await this.assertCurrent(db, actor, ownerPrincipalId, scope, relied);
      return { hits, rejected, deadline };
    });
    // Locks fence revocation, not time: the earliest expiry the final check saw, of the provider credential (a session's
    // or a key's) and of the regional key and every relied grant, must still lie ahead when COMMIT was acknowledged.
    if (performance.now() >= deadline) throw new AuthorityError('FORBIDDEN', 'Access expired before the search committed');

    // Coverage from what actually ran: a collection's readable kinds are searched only through a list that ran over it.
    const collections: SearchCollection[] = planned.map(entry => ({ collectionId: entry.collectionId,
      generation: entry.active?.generation ?? null, lexical: entry.active?.lexical === true, vector: entry.vector,
      vectorError: entry.vector === 'unavailable' ? entry.vectorError : null, projection: entry.projection,
      unsearched: entry.active?.lexical || entry.vector === 'used' ? entry.unprojected : entry.kinds }));
    const vectorDown = collections.some(entry => entry.vector === 'unavailable');
    const degraded = vectorDown || collections.some(entry => entry.projection === 'degraded');
    const pending = collections.some(entry => entry.projection === 'pending' || entry.projection === 'unindexed');
    // Exhausted only when every searched list returned all it had (no bound reached, no ANN list) and nothing readable went
    // unsearched: no collection left out, every requested readable kind of every collection covered by a list that ran,
    // every collection current with its authority and no vector side down.
    const covered = !collectionsCapped && collections.every(entry => !entry.unsearched.length && entry.projection === 'current'
      && entry.vector !== 'unavailable');
    const reasons: [SearchUnderfill, boolean][] = [
      ['rejected', rejected.deleted + rejected.stale + rejected.unauthorized > 0], ['bounded', bounded],
      ['capped', collectionsCapped], ['approximate', approximate], ['exhausted', !bounded && !approximate && covered],
      ['degraded', vectorDown], ['unindexed', collections.some(entry => entry.projection === 'unindexed')],
      ['pending', collections.some(entry => entry.projection === 'pending' || entry.projection === 'degraded')],
      ['unprojected', planned.some(entry => entry.unprojected.length > 0)]];
    return { spaceId, query: input.query, limit: input.limit,
      mode: collections.some(entry => entry.vector === 'used') ? 'hybrid' : 'lexical',
      state: degraded ? 'degraded' : pending ? 'pending' : 'current', complete: false, results: hits,
      underfill: hits.length >= input.limit ? null : { returned: hits.length, requested: input.limit,
        reasons: reasons.filter(([, applies]) => applies).map(([reason]) => reason) },
      candidates: { lexical: lexical.length, vector: vectorLists.reduce((sum, list) => sum + list.length, 0),
        considered: considered.length },
      rejected, collections, collectionsCapped };
  }

  /**
   * Share lock what the reread relies on through commit, as `checkScope`
   * does: the space at the admitted policy and placement and, for the owner,
   * the searched collections; for a key, its credential and every grant it
   * holds in the space with the grant's collection. A revocation, grant
   * change, suspension, deletion or placement fence therefore either
   * committed before, and is seen here, or waits for this read to commit.
   */
  private async lockScope(db: Db, scope: AuthorityScope, owner: boolean, searched: string[]): Promise<Access> {
    const space = (await db.query(`SELECT lifecycle,policy_version,placement_generation FROM spaces WHERE space_id=$1 FOR SHARE`,
      [scope.spaceId])).rows[0];
    if (!space || space.lifecycle === 'deleted') throw new AuthorityError('NOT_FOUND');
    if (Number(space.policy_version) !== scope.policyVersion || Number(space.placement_generation) !== scope.placementGeneration)
      throw new AuthorityError('FORBIDDEN', 'Policy or placement changed');
    if (space.lifecycle !== 'active' && space.lifecycle !== 'readOnly') throw new AuthorityError('SPACE_UNAVAILABLE');
    if (owner) {
      const rows = (await db.query(`SELECT collection_id FROM collections WHERE space_id=$1 AND collection_id=ANY($2::text[])
        AND lifecycle<>'deleted' ORDER BY collection_id COLLATE "C" FOR SHARE`, [scope.spaceId, searched])).rows;
      return { owner, grants: new Map(rows.map(row => [String(row.collection_id), Object.values(READ)])) };
    }
    const credential = (await db.query(`SELECT 1 FROM space_credentials WHERE space_id=$1 AND credential_id=$2
      AND principal_id=$3 AND activated_at IS NOT NULL AND confirmed_at IS NOT NULL AND revoked_at IS NULL
      AND expires_at>clock_timestamp() FOR SHARE`, [scope.spaceId, scope.credentialId, scope.principalId])).rows[0];
    if (!credential) throw new AuthorityError('FORBIDDEN');
    const grants = (await db.query(`SELECT g.collection_id,g.capabilities FROM collection_grants g
      JOIN collections c ON c.space_id=g.space_id AND c.collection_id=g.collection_id
      WHERE g.space_id=$1 AND g.credential_id=$2 AND c.lifecycle<>'deleted'
        AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
      ORDER BY g.collection_id COLLATE "C" FOR SHARE OF g,c`, [scope.spaceId, scope.credentialId])).rows;
    return { owner, grants: new Map(grants.map(row => [String(row.collection_id), row.capabilities as string[]])) };
  }

  /**
   * The credential check, before each query embedding call and after the
   * last read: the provider confirms the credential (a session or a key) with
   * its expiry, then, for a key, one statement against one clock reading
   * confirms the regional key and every grant the response relies on
   * (`dependencies`, plus `sources:read` on every collection a returned claim
   * cites). Returns the earliest of all their expiries on `performance.now()`'s
   * clock (each measured from before its read, so never later than the real
   * one; Infinity only when none of them expires); the final caller requires
   * COMMIT to be acknowledged before it.
   */
  private async assertCurrent(db: Db, actor: VerifiedCredential, ownerPrincipalId: string, scope: AuthorityScope,
    relied: ReadonlySet<string>): Promise<number> {
    const started = performance.now();
    const wall = Date.now();
    const until = await this.spaces.assertCurrentUntil(actor, ownerPrincipalId);
    const provider = until === null ? Infinity : started + until - wall;
    if (actor.kind !== 'api-key') return provider;
    const pairs = pairsOf(relied);
    const at = performance.now();
    // Per pair, the latest-lasting grant holding it; the credential's expiry is finite, so the earliest is too.
    const row = (await db.query(`WITH t AS MATERIALIZED (SELECT clock_timestamp() AS now),
      k AS (SELECT sc.expires_at FROM t,space_credentials sc WHERE sc.space_id=$1 AND sc.credential_id=$2
          AND sc.owner_principal_id=$3 AND sc.activated_at IS NOT NULL AND sc.confirmed_at IS NOT NULL AND sc.revoked_at IS NULL
          AND sc.expires_at>t.now),
      r AS (SELECT (SELECT max(COALESCE(g.expires_at,'infinity'::timestamptz)) FROM collection_grants g
          JOIN collections c ON c.space_id=g.space_id AND c.collection_id=g.collection_id
          WHERE g.space_id=$1 AND g.credential_id=$2 AND g.collection_id=n.collection_id AND n.capability=ANY(g.capabilities)
            AND c.lifecycle<>'deleted' AND (g.expires_at IS NULL OR g.expires_at>t.now)) AS expires_at
        FROM t,unnest($4::text[],$5::text[]) AS n(collection_id,capability))
      SELECT EXISTS (SELECT 1 FROM k) AND NOT EXISTS (SELECT 1 FROM r WHERE expires_at IS NULL) AS current,
        EXTRACT(EPOCH FROM LEAST((SELECT min(expires_at) FROM k),(SELECT min(expires_at) FROM r))-(SELECT now FROM t))*1000
          AS remaining_ms`,
    [scope.spaceId, scope.credentialId, ownerPrincipalId, pairs.map(pair => pair[0]), pairs.map(pair => pair[1])])).rows[0];
    const remainingMs = Number(row?.remaining_ms);
    if (row?.current !== true || !Number.isFinite(remainingMs) || remainingMs <= 0) throw new AuthorityError('FORBIDDEN');
    return Math.min(provider, at + remainingMs);
  }
}
