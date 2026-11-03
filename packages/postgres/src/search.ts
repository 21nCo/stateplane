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
export type SearchUnderfill = 'rejected' | 'bounded' | 'capped' | 'approximate' | 'exhausted' | 'degraded' | 'unindexed' | 'pending';
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
 * at most 200; up to 32 collections per search; the query embedding gets one
 * try of at most 2 s.
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
  /** The active generation, with the kinds the caller asked for and may read, and its vector identity when vectors are on. */
  active: (ActiveGeneration & { policyVersion: number; lexical: boolean; identity: EmbedderIdentity | null; regions: string[] }) | null;
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
 * Only chunks of what the caller could read when the candidates are read: the
 * Ref live at the chunk's revision (and, for a source, its latest extraction),
 * and a claim citing only live collections in `evidence` (every live one when
 * null). Deleted, superseded and hidden content then leaves no trace in a
 * candidate list, its counts or its ranks; the reread still checks everything.
 */
const readable = (chunk: string, evidence: string) => `AND CASE ${chunk}.ref_kind
    WHEN 'record' THEN EXISTS (SELECT 1 FROM records r WHERE r.space_id=${chunk}.space_id AND r.collection_id=${chunk}.collection_id
      AND r.record_id=${chunk}.ref_id AND r.revision=${chunk}.revision AND NOT r.tombstone)
    ELSE EXISTS (SELECT 1 FROM entity_refs e WHERE e.space_id=${chunk}.space_id AND e.collection_id=${chunk}.collection_id
      AND e.kind=${chunk}.ref_kind AND e.entity_id=${chunk}.ref_id AND e.revision=${chunk}.revision AND NOT e.tombstone) END
  AND (${chunk}.ref_kind<>'source' OR ${chunk}.extraction_version=(SELECT max(x.version) FROM extraction_versions x
    WHERE x.space_id=${chunk}.space_id AND x.collection_id=${chunk}.collection_id AND x.source_id=${chunk}.ref_id))
  AND (${chunk}.ref_kind<>'claim' OR NOT EXISTS (SELECT 1 FROM claim_evidence a
    LEFT JOIN collections k ON k.space_id=a.space_id AND k.collection_id=a.source_collection_id
    WHERE a.space_id=${chunk}.space_id AND a.collection_id=${chunk}.collection_id AND a.claim_id=${chunk}.ref_id
      AND (k.collection_id IS NULL OR k.lifecycle='deleted'
        OR (${evidence}::text[] IS NOT NULL AND a.source_collection_id<>ALL(${evidence}::text[])))))`;

/**
 * The lexical and vector candidate ports over PostgreSQL full-text search
 * and pgvector. Each call is one short transaction of its own, reading only
 * the given active generations and, in each, only the kinds it lists;
 * candidates are pointers for a reread, never results.
 */
export class PostgresCandidates implements LexicalCandidates, VectorCandidates {
  constructor(private readonly pool: Pick<pg.Pool, 'connect'>) {}

  /**
   * Chunks whose `tsvector` matches the query under each generation's own
   * text search configuration (`websearch_to_tsquery`), ranked by
   * `ts_rank_cd`; each Ref's best chunk, best first.
   */
  async lexical(scope: CandidateScope, query: string, limit: number): Promise<ChunkCandidate[]> {
    if (!scope.generations.length) return [];
    return transact(this.pool, async db => (await db.query(`WITH m AS (
        SELECT l.${candidateColumns.replaceAll(',', ',l.')},ts_rank_cd(l.tsv,q.query)::float8 AS score
        FROM unnest($2::text[],$3::bigint[],$4::text[],$5::text[]) AS a(collection_id,generation,kinds,config)
        CROSS JOIN LATERAL (SELECT websearch_to_tsquery(a.config::regconfig,$6) AS query) q
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
   * Still approximate: never complete recall.
   */
  async nearest(scope: CandidateScope, identity: EmbedderIdentity, embedding: readonly number[], limit: number)
    : Promise<ChunkCandidate[]> {
    const dimensions = identity.dimensions;
    if (!Number.isSafeInteger(dimensions) || dimensions < 1 || embedding.length !== dimensions || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 1_000) throw new RangeError('Invalid vector search');
    if (!scope.generations.length) return [];
    // The cast and `dimensions` literal are what the partial index is defined with; both are checked integers.
    const distance = `(v.embedding::vector(${dimensions})) <=> $6::vector(${dimensions})`;
    return transact(this.pool, async db => {
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
 * allow, and its projection state. A plan only chooses what to read; the
 * reread decides what is returned.
 */
async function plan(db: Db, scope: AuthorityScope, owner: boolean, request: Request): Promise<Planned[]> {
  const capabilities = request.kinds.map(kind => READ[kind]);
  const rows = (await db.query(`SELECT c.collection_id,g.capabilities,a.generation,a.policy_version,p.lexical,p.vector,
      p.text_search_config,a.embedder,a.embedding_model,a.model_version,a.dimensions,
      ARRAY(SELECT r FROM unnest(cur.processing_regions) WITH ORDINALITY u(r,n) WHERE r=ANY(p.processing_regions) ORDER BY n) AS regions
    FROM collections c
    LEFT JOIN collection_grants g ON NOT $3 AND g.space_id=c.space_id AND g.collection_id=c.collection_id AND g.credential_id=$2
      AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
    LEFT JOIN projection_generations a ON a.space_id=c.space_id AND a.collection_id=c.collection_id AND a.state='active'
    LEFT JOIN retrieval_policies p ON p.space_id=a.space_id AND p.collection_id=a.collection_id AND p.version=a.policy_version
    LEFT JOIN retrieval_collection_heads h ON h.space_id=a.space_id AND h.collection_id=a.collection_id
    LEFT JOIN retrieval_policies cur ON cur.space_id=h.space_id AND cur.collection_id=h.collection_id AND cur.version=h.policy_version
    WHERE c.space_id=$1 AND c.lifecycle<>'deleted' AND ($4::text[] IS NULL OR c.collection_id=ANY($4::text[]))
      AND ($3 OR g.capabilities && $5::text[])
    ORDER BY c.collection_id COLLATE "C" LIMIT $6`,
  [scope.spaceId, scope.credentialId, owner, request.collections, capabilities, searchBounds.collections + 1])).rows;
  const planned: Planned[] = rows.map(row => {
    const kinds = request.kinds.filter(kind => owner || (row.capabilities as string[]).includes(READ[kind]));
    const vector = row.vector === true && row.embedder !== null;
    return { collectionId: String(row.collection_id),
      active: row.generation === null ? null : { collectionId: String(row.collection_id), generation: Number(row.generation), kinds,
        policyVersion: Number(row.policy_version), textSearchConfig: String(row.text_search_config), lexical: row.lexical === true,
        regions: row.regions as string[], identity: vector ? { embedder: row.embedder, model: row.embedding_model,
          modelVersion: row.model_version, dimensions: Number(row.dimensions) } : null },
      projection: row.generation === null ? 'unindexed' : 'current', vector: vector ? 'unavailable' : 'disabled', vectorError: null };
  });
  const indexed = planned.filter(entry => entry.active).map(entry => entry.collectionId);
  if (!indexed.length) return planned;
  // Pending and degraded as the worker's status reports them: work waiting; a failure or error among the oldest-due rows,
  // or a failed record delivery anywhere. Exact reads never depend on this.
  const states = new Map((await db.query(`SELECT x.collection_id,
      EXISTS (SELECT 1 FROM projection_outbox WHERE space_id=$1 AND collection_id=x.collection_id AND ${LIVE_OUTBOX})
        OR EXISTS (SELECT 1 FROM retrieval_outbox WHERE space_id=$1 AND collection_id=x.collection_id
          AND delivery_state='pending') AS pending,
      EXISTS (SELECT 1 FROM projection_outbox WHERE space_id=$1 AND collection_id=x.collection_id AND ${FAILED_OUTBOX})
        OR EXISTS (SELECT 1 FROM (SELECT last_error FROM projection_outbox WHERE space_id=$1 AND collection_id=x.collection_id
          AND ${LIVE_OUTBOX} ORDER BY available_at,event_id LIMIT $3) s WHERE s.last_error IS NOT NULL)
        OR EXISTS (SELECT 1 FROM (SELECT last_error FROM retrieval_outbox WHERE space_id=$1 AND collection_id=x.collection_id
          AND delivery_state='pending' ORDER BY available_at,job_id LIMIT $3) s WHERE s.last_error IS NOT NULL) AS degraded
    FROM unnest($2::text[]) AS x(collection_id)`, [scope.spaceId, indexed, STATUS_SAMPLE])).rows
    .map(row => [String(row.collection_id), row.degraded ? 'degraded' : row.pending ? 'pending' : 'current'] as const));
  for (const entry of planned) if (entry.active) entry.projection = states.get(entry.collectionId) ?? 'current';
  return planned;
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
  review: SearchHit['review']; attributedTo: string | null; evidence: ClaimEvidenceView[]; cited: string[];
  citesDeleted: boolean; verifiedAt: string;
}

/**
 * Reread every candidate citation at authority in one statement, so all of
 * them come from one snapshot: the Ref's current revision and tombstone, a
 * source's latest extraction, the cited range of the record field,
 * extraction or claim revision the chunk was built from (sliced by code
 * point in SQL, so only the range leaves the database), a claim revision's
 * review, attribution and evidence, and every collection any revision of the
 * claim cites (and whether one of them is deleted).
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
        AND a.collection_id=c.collection_id AND a.claim_id=c.id) AS cited,
      EXISTS (SELECT 1 FROM claim_evidence a JOIN collections k ON k.space_id=a.space_id AND k.collection_id=a.source_collection_id
        WHERE c.kind='claim' AND a.space_id=$1 AND a.collection_id=c.collection_id AND a.claim_id=c.id
          AND k.lifecycle='deleted') AS cites_deleted
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
    attributedTo: row.attributed_to ?? null, cited: row.cited, citesDeleted: row.cites_deleted === true,
    verifiedAt: iso(row.verified_at)!,
    evidence: ((row.evidence ?? []) as unknown[][]).map(item => ({ collectionId: String(item[0]), sourceId: String(item[1]),
      extractionVersion: item[2] === null ? null : Number(item[2]), start: item[3] === null ? null : Number(item[3]),
      end: item[4] === null ? null : Number(item[4]) })) }));
}

/**
 * The cited range of a record whose `jsonb` cannot hold its text, from its
 * canonical JSON at the candidate's revision. Read one record at a time and
 * only for a candidate about to be returned, so at most `limit` records'
 * canonical JSON (each at most 1 MiB) is read, one after another.
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

/** Whether authority still holds the exact revision (and extraction) a citation was built from, with its text. */
const holds = (candidate: ChunkCandidate, read: Reread) => read.tombstone === false && read.currentRevision === candidate.revision
  && read.text !== null && (candidate.kind !== 'source' || read.latestExtraction === candidate.extractionVersion);

/** What the caller may read now, under the locks `lockScope` holds. */
interface Access { owner: boolean; grants: Map<string, readonly string[]> }
const mayRead = (access: Access, collectionId: string, capability: string) =>
  access.grants.get(collectionId)?.includes(capability) === true;

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
    const { all, evidence } = await transact(cell.pool, async db => ({ all: await plan(db, scope, owner, input),
      evidence: await evidenceCollections(db, scope, owner) }));
    const collectionsCapped = all.length > searchBounds.collections;
    const planned = all.slice(0, searchBounds.collections);
    if (input.collections && planned.length !== input.collections.length) throw new AuthorityError('NOT_FOUND');
    if (!owner && !planned.length) throw new AuthorityError('FORBIDDEN');
    const bound = overfetch(input.limit);
    const candidates = new PostgresCandidates(cell.pool);
    const scopeOf = (entries: Planned[]): CandidateScope => ({ spaceId, generations: entries.map(entry => entry.active!),
      evidenceCollections: evidence });

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
    for (const { identity, embedder, entries } of groups.values()) {
      let embedding: number[];
      let admitted: Planned[] = [];
      let stage: 'admission' | 'embedding' = 'admission';
      // Just before the call, in a fresh read: the space still open at the admitted policy and placement, and each
      // collection live at the planned active generation with the embedder's region allowed by both policies. A
      // narrowing committed during an earlier group's call therefore stops this one; one committed during this call
      // cannot recall it, as for the worker.
      const admit = async () => {
        const current = await transact(cell.pool, db => admission(db, scope, entries.map(entry => entry.collectionId)));
        admitted = entries.filter(entry => {
          const now = current.get(entry.collectionId);
          return now !== undefined && now.generation === entry.active!.generation && now.policyVersion === entry.active!.policyVersion
            && now.regions.includes(embedder.profile.region);
        });
        for (const entry of entries) if (!admitted.includes(entry)) entry.vectorError = 'POLICY_CHANGED';
        if (!admitted.length) throw new AdmissionClosed();
        stage = 'embedding';
      };
      // One try; a call that outlasts the bound, even one ignoring its signal, is an outage and is not waited for.
      const signal = AbortSignal.timeout(searchBounds.embedMs);
      try { [embedding] = await within(embedBatch(embedder, [input.query], signal, [], admit), signal); }
      catch (error) {
        if (error instanceof AdmissionClosed) continue;
        for (const entry of stage === 'admission' ? entries : admitted)
          entry.vectorError = stage === 'admission' ? 'VECTOR_QUERY_FAILED'
            : error instanceof EmbedderUnavailableError || signal.aborted ? 'EMBEDDER_UNAVAILABLE' : 'EMBEDDER_FAILED';
        continue;
      }
      try { vectorLists.push(await candidates.nearest(scopeOf(admitted), identity, embedding, bound)); }
      catch { for (const entry of admitted) entry.vectorError = 'VECTOR_QUERY_FAILED'; continue; }
      for (const entry of admitted) entry.vector = 'used';
    }
    const lexical = await candidates.lexical(scopeOf(planned.filter(entry => entry.active?.lexical)), input.query, bound);

    // Fuse one list per source, each deduplicated to the Ref's best chunk, and consider at most `bound` Refs.
    const lists = [lexical, ...vectorLists].map(list => {
      const best = new Map<string, ChunkCandidate>();
      for (const hit of list) if (!best.has(refKey(hit))) best.set(refKey(hit), hit);
      return best;
    });
    const fused = fuseRanks(lists.map(list => [...list.keys()]));
    const considered = fused.slice(0, bound);
    const bounded = lexical.length >= bound || vectorLists.some(list => list.length >= bound) || fused.length > bound;
    // A filtered approximate scan can stop short (pgvector's hnsw.max_scan_tuples), so a short vector list proves nothing.
    const approximate = vectorLists.some(list => list.length < bound);
    // Each considered Ref's citations: its best chunk from every list it is in, lexical first.
    const cited = considered.map(entry => lists.flatMap((list, from) => {
      const hit = list.get(entry.key);
      return hit ? [{ from, hit }] : [];
    }));

    const { hits, rejected } = await transact(cell.pool, async db => {
      const access = await this.lockScope(db, scope, owner, planned.map(entry => entry.collectionId));
      const active = await activeGenerations(db, spaceId, planned.map(entry => entry.collectionId));
      const flat = cited.flat();
      const reads = flat.length ? await reread(db, spaceId, flat.map(item => item.hit)) : [];
      const readOf = new Map(flat.map((item, at) => [item, reads[at]]));
      const rejected = { deleted: 0, stale: 0, unauthorized: 0 };
      const hits: SearchHit[] = [];
      const relied = new Set<string>();
      for (let index = 0; index < considered.length && hits.length < input.limit; index++) {
        const head = cited[index][0].hit;
        const capability = READ[head.kind];
        if (!mayRead(access, head.collectionId, capability)) { rejected.unauthorized++; continue; }
        const first = readOf.get(cited[index][0])!;
        if (first.currentRevision === null || first.tombstone !== false) { rejected.deleted++; continue; }
        // Only citations from the active generation of exactly what authority holds now; a Ref with none left is stale.
        const generation = active.get(head.collectionId);
        const current: typeof cited[number] = [];
        for (const item of cited[index]) {
          if (generation?.generation !== item.hit.generation || generation.policyVersion !== item.hit.policyVersion) continue;
          const read = readOf.get(item)!;
          if (read.canonical && read.currentRevision === item.hit.revision) read.text = await canonicalRange(db, spaceId, item.hit);
          if (holds(item.hit, read)) current.push(item);
        }
        if (!current.length) { rejected.stale++; continue; }
        const read = readOf.get(current[0])!;
        // The claim read rule: a claim citing a collection whose sources the caller cannot read does not exist for it.
        if (head.kind === 'claim' && (read.citesDeleted || (!access.owner && read.cited.some(id => !mayRead(access, id, 'sources:read'))))) {
          rejected.unauthorized++; continue;
        }
        relied.add(JSON.stringify([head.collectionId, capability]));
        for (const id of head.kind === 'claim' ? read.cited : []) relied.add(JSON.stringify([id, 'sources:read']));
        const entry = planned.find(item => item.collectionId === head.collectionId)!;
        const ranks = considered[index].ranks;
        const chunk = current[0].hit;
        // One citation per chunk, naming every list that found it there.
        const citations: SearchCitation[] = [];
        for (const item of current) {
          const by = item.from === 0 ? 'lexical' as const : 'vector' as const;
          const same = citations.find(other => other.chunk === item.hit.chunk);
          if (same) { if (!same.matchedBy.includes(by)) same.matchedBy.push(by); continue; }
          citations.push({ matchedBy: [by], chunk: item.hit.chunk, field: item.hit.field, start: item.hit.start, end: item.hit.end,
            sourceStart: item.hit.sourceStart, sourceEnd: item.hit.sourceEnd, text: readOf.get(item)!.text! });
        }
        hits.push({ ref: { spaceId, collectionId: chunk.collectionId, kind: chunk.kind, id: chunk.id }, revision: chunk.revision,
          extractionVersion: chunk.extractionVersion, score: considered[index].score, citations,
          provenance: { generation: chunk.generation, policyVersion: chunk.policyVersion, lexicalRank: ranks[0],
            vectorRank: ranks.slice(1).find(rank => rank !== null) ?? null,
            embedder: current.some(item => item.from > 0) ? entry.active!.identity : null,
            attributedTo: read.attributedTo, evidence: head.kind === 'claim' ? read.evidence : [] },
          review: head.kind === 'claim' ? read.review : null,
          freshness: { verifiedAt: read.verifiedAt, projection: entry.projection === 'unindexed' ? 'pending' : entry.projection } });
      }
      await this.assertCurrent(db, actor, ownerPrincipalId, scope, relied);
      return { hits, rejected };
    });

    const collections: SearchCollection[] = planned.map(entry => ({ collectionId: entry.collectionId,
      generation: entry.active?.generation ?? null, lexical: entry.active?.lexical === true, vector: entry.vector,
      vectorError: entry.vector === 'unavailable' ? entry.vectorError : null, projection: entry.projection }));
    const vectorDown = collections.some(entry => entry.vector === 'unavailable');
    const degraded = vectorDown || collections.some(entry => entry.projection === 'degraded');
    const pending = collections.some(entry => entry.projection === 'pending' || entry.projection === 'unindexed');
    // Exhausted only when every searched list returned all it had: no bound reached, no collection left out, no ANN list.
    const reasons: [SearchUnderfill, boolean][] = [
      ['rejected', rejected.deleted + rejected.stale + rejected.unauthorized > 0], ['bounded', bounded],
      ['capped', collectionsCapped], ['approximate', approximate], ['exhausted', !bounded && !collectionsCapped && !approximate],
      ['degraded', vectorDown], ['unindexed', collections.some(entry => entry.projection === 'unindexed')],
      ['pending', collections.some(entry => entry.projection === 'pending' || entry.projection === 'degraded')]];
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
   * The final check, after the last read: the provider confirms the
   * credential, then one statement against one clock reading confirms the
   * key and every grant a returned hit relied on (its collection's read
   * capability and, for a claim, `sources:read` on every cited collection).
   */
  private async assertCurrent(db: Db, actor: VerifiedCredential, ownerPrincipalId: string, scope: AuthorityScope,
    relied: Set<string>): Promise<void> {
    await this.spaces.assertCurrent(actor, ownerPrincipalId);
    if (actor.kind !== 'api-key') return;
    const pairs = [...relied].map(pair => JSON.parse(pair) as [string, string]);
    const row = (await db.query(`WITH t AS (SELECT clock_timestamp() AS now)
      SELECT EXISTS (SELECT 1 FROM t,space_credentials sc WHERE sc.space_id=$1 AND sc.credential_id=$2
          AND sc.owner_principal_id=$3 AND sc.activated_at IS NOT NULL AND sc.confirmed_at IS NOT NULL AND sc.revoked_at IS NULL
          AND sc.expires_at>t.now)
        AND NOT EXISTS (SELECT 1 FROM t,unnest($4::text[],$5::text[]) AS n(collection_id,capability) WHERE NOT EXISTS (
          SELECT 1 FROM collection_grants g JOIN collections c ON c.space_id=g.space_id AND c.collection_id=g.collection_id
          WHERE g.space_id=$1 AND g.credential_id=$2 AND g.collection_id=n.collection_id AND n.capability=ANY(g.capabilities)
            AND c.lifecycle<>'deleted' AND (g.expires_at IS NULL OR g.expires_at>t.now))) AS current`,
    [scope.spaceId, scope.credentialId, ownerPrincipalId, pairs.map(pair => pair[0]), pairs.map(pair => pair[1])])).rows[0];
    if (row?.current !== true) throw new AuthorityError('FORBIDDEN');
  }
}
