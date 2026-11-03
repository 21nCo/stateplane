/** The kinds of canonical Ref a projection holds. */
export type RefKind = 'record' | 'source' | 'claim';

/**
 * One collection's active generation, which is all a search reads of it, with
 * the kinds of Ref the caller asked for and may read there.
 */
export interface ActiveGeneration { collectionId: string; generation: number; textSearchConfig: string; kinds: readonly RefKind[] }
/** What candidates may come from: one space and its granted collections' active generations. */
export interface CandidateScope { spaceId: string; generations: readonly ActiveGeneration[] }
/**
 * One projected chunk that matched: its canonical Ref, the authoritative
 * revision (and extraction) and generation it was built from, its offsets,
 * and its score in the list (higher is better). A candidate is a pointer
 * to authority, never evidence that its Ref is current, readable or
 * complete: callers reread and reauthorize it before returning anything.
 */
export interface ChunkCandidate {
  collectionId: string; kind: RefKind; id: string; revision: number; extractionVersion: number | null;
  generation: number; policyVersion: number; chunk: number; field: string | null;
  start: number; end: number; sourceStart: number | null; sourceEnd: number | null; score: number;
}
/**
 * Lexical candidates: the best chunk of each matching Ref, at most `limit`
 * Refs over all of the scope's generations, best first.
 */
export interface LexicalCandidates {
  lexical(scope: CandidateScope, query: string, limit: number): Promise<ChunkCandidate[]>;
}
/**
 * Vector candidates: the nearest `limit` chunks to `embedding` in the
 * scope's generations, which must all be built with `identity`, nearest
 * first. An approximate index filtered to a scope may return fewer or other
 * chunks than an exact search would, so a result is never complete.
 */
export interface VectorCandidates {
  nearest(scope: CandidateScope, identity: EmbedderIdentity, embedding: readonly number[], limit: number): Promise<ChunkCandidate[]>;
}

/**
 * The model a vector generation is built with. A generation pins exactly one
 * identity, so vectors from different models or versions never mix.
 */
export interface EmbedderIdentity { embedder: string; model: string; modelVersion: string; dimensions: number }
/**
 * One configured embedder in one processing region. `quality` is a relative
 * score from evaluation (higher is better), `costPerMillionCodePoints` a
 * relative cost in the operator's unit; neither is a provider guarantee.
 * `maxBatch` and `maxInputCodePoints` are the provider limits the caller
 * must respect.
 */
export interface EmbedderProfile extends EmbedderIdentity {
  region: string; quality: number; costPerMillionCodePoints: number; maxBatch: number; maxInputCodePoints: number;
}
/**
 * The embedding port. `embed` is an external call: callers never run it
 * inside a database transaction. It returns one vector per input, in order.
 * A provider that cannot be reached or is overloaded throws
 * `EmbedderUnavailableError`; anything else it throws is the input's.
 * Errors may quote the input, so `embedBatch` keeps only their category:
 * whatever `embed` throws reaches the caller as an `EmbedderUnavailableError`
 * or an `EmbedderFailedError` with a fixed message and no cause, and no
 * provider text is ever recorded.
 */
export interface Embedder {
  readonly profile: EmbedderProfile;
  embed(texts: readonly string[], signal: AbortSignal): Promise<number[][]>;
}

/** Code of an outage: the work stays due and never spends a failure budget. */
export const EMBEDDER_UNAVAILABLE = 'EMBEDDER_UNAVAILABLE';
/** Code of preparation stopped by its time budget with its progress saved; the work resumes. */
export const PROJECTION_INCOMPLETE = 'PROJECTION_INCOMPLETE';
/** The provider is unreachable, overloaded or not configured for an allowed region. Retried; never counts as the input's fault. */
export class EmbedderUnavailableError extends Error {
  readonly code = EMBEDDER_UNAVAILABLE;
  constructor(message = 'Embedder unavailable', options?: ErrorOptions) { super(message, options); this.name = 'EmbedderUnavailableError'; }
}
/** Preparation saved some work and stopped before its budget ran out; the next attempt continues from its checkpoints. */
export class ProjectionIncompleteError extends Error {
  readonly code = PROJECTION_INCOMPLETE;
  constructor(message = 'Projection preparation incomplete') { super(message); this.name = 'ProjectionIncompleteError'; }
}
/** The embedder failed for the input, for a reason it does not disclose. Counts as the input's. */
export class EmbedderFailedError extends Error {
  constructor() { super('The embedder failed for this input'); this.name = 'EmbedderFailedError'; }
}
/** The provider answered with something that is not one finite vector of its dimensions per input. Counts as the input's. */
export class EmbeddingRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'EmbeddingRejectedError'; }
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const label = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;
const positive = (value: unknown, max: number) => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Reject a profile the projection storage would refuse or a caller could not respect. */
export function validProfile(profile: EmbedderProfile): boolean {
  return NAME.test(profile?.embedder ?? '') && label(profile.model, 256) && label(profile.modelVersion, 256)
    && positive(profile.dimensions, 16_000) && REGION.test(profile.region ?? '') && finite(profile.quality)
    && finite(profile.costPerMillionCodePoints) && positive(profile.maxBatch, 2_048)
    && positive(profile.maxInputCodePoints, 1_000_000);
}

export const sameIdentity = (a: EmbedderIdentity, b: EmbedderIdentity) => a.embedder === b.embedder && a.model === b.model
  && a.modelVersion === b.modelVersion && a.dimensions === b.dimensions;

// Every field of a profile: the registry's snapshot and the adapter's own profile must agree on all of them.
const PROFILE_FIELDS = ['embedder', 'model', 'modelVersion', 'dimensions', 'region', 'quality', 'costPerMillionCodePoints',
  'maxBatch', 'maxInputCodePoints'] as const satisfies readonly (keyof EmbedderProfile)[];
/** Whether the adapter's profile, read now, still matches `profile` in every field; an unreadable one does not. */
function unchanged(embedder: Embedder, profile: EmbedderProfile): boolean {
  try {
    const live = embedder.profile;
    return !!live && PROFILE_FIELDS.every(field => live[field] === profile[field]);
  } catch { return false; }
}

/** What a new vector generation needs from its embedder. */
export interface EmbedderRequirements {
  /** Regions the collection's policy allows, in preference order. */
  regions: readonly string[];
  /** Dimensions the cell has an index strategy for. */
  dimensions: readonly number[];
  /** Longest input the chunker produces, in code points. */
  inputCodePoints: number;
  minQuality?: number;
}

/**
 * Configured embedders, by identity and processing region. Selection only
 * ever returns an embedder in a region the caller's policy allows, so
 * content is never sent to a region its policy excludes.
 */
export class EmbeddingRegistry {
  readonly #embedders: readonly Embedder[];
  /**
   * Each embedder is kept as a frozen snapshot of its validated profile, and
   * selection returns that snapshot: changing the original profile
   * afterwards never changes which identity, region or limits are
   * authorized or used. The snapshot's `embed` rereads the adapter's own
   * profile before every call and refuses, without calling it, unless that
   * profile can be read and still matches the snapshot in every field, so an
   * adapter never runs under an identity, region or limit other than the one
   * authorized. A refusal is always a rejected `EmbedderUnavailableError`.
   */
  constructor(embedders: readonly Embedder[] = []) {
    const seen = new Set<string>();
    const snapshots: Embedder[] = [];
    for (const embedder of embedders) {
      const source = embedder?.profile;
      const embed = embedder?.embed;
      if (!source || typeof source !== 'object' || typeof embed !== 'function') throw new RangeError('Invalid embedder profile');
      const profile: EmbedderProfile = Object.freeze(Object.fromEntries(PROFILE_FIELDS.map(field => [field, source[field]])) as never);
      if (!validProfile(profile)) throw new RangeError('Invalid embedder profile');
      const key = JSON.stringify([profile.embedder, profile.model, profile.modelVersion, profile.dimensions, profile.region]);
      if (seen.has(key)) throw new RangeError('Duplicate embedder in one region');
      seen.add(key);
      snapshots.push(Object.freeze({ profile, embed: async (texts: readonly string[], signal: AbortSignal) => {
        // The adapter's profile as it is now: a replaced object, a throwing profile or field getter, or a proxy
        // trap refuses as an outage, always by rejecting, and never runs the adapter.
        if (!unchanged(embedder, profile)) throw new EmbedderUnavailableError('Embedder profile changed after registration');
        return await embed.call(embedder, texts, signal);
      } }));
    }
    this.#embedders = Object.freeze(snapshots);
  }

  get size(): number { return this.#embedders.length; }

  /**
   * Choose the embedder for a new generation: in an allowed region, with a
   * recorded dimension, accepting the chunker's input and of at least the
   * required quality; then the cheapest, then the best, then the earliest
   * allowed region, then by name.
   */
  select(requirements: EmbedderRequirements): Embedder | null {
    const minQuality = requirements.minQuality ?? 0;
    const order = (region: string) => requirements.regions.indexOf(region);
    const eligible = this.#embedders.filter(({ profile }) => order(profile.region) >= 0
      && requirements.dimensions.includes(profile.dimensions) && profile.maxInputCodePoints >= requirements.inputCodePoints
      && profile.quality >= minQuality);
    eligible.sort((a, b) => a.profile.costPerMillionCodePoints - b.profile.costPerMillionCodePoints
      || b.profile.quality - a.profile.quality || order(a.profile.region) - order(b.profile.region)
      || a.profile.embedder.localeCompare(b.profile.embedder) || a.profile.model.localeCompare(b.profile.model));
    return eligible[0] ?? null;
  }

  /**
   * The embedder with exactly a generation's identity in the first allowed
   * region that has one and accepts `inputCodePoints`, or null.
   */
  resolve(identity: EmbedderIdentity, regions: readonly string[], inputCodePoints: number): Embedder | null {
    for (const region of regions) {
      const found = this.#embedders.find(({ profile }) => profile.region === region && sameIdentity(profile, identity)
        && profile.maxInputCodePoints >= inputCodePoints);
      if (found) return found;
    }
    return null;
  }
}

/**
 * Bounded retry of a provider outage. Initial protective values, not
 * measured provider behavior: three tries per batch, waiting 250 ms then
 * 1 s, never past the caller's signal. A longer outage surfaces as
 * `EmbedderUnavailableError` and the work is retried later from its
 * checkpoints.
 */
export const EMBED_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(signal.reason); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

const isUnavailable = (error: unknown) => error instanceof EmbedderUnavailableError;

/**
 * Call one batch, retrying only an outage, and check the answer's shape.
 * `admit` runs before every call, including each retry, and stops the batch
 * by throwing: the caller rechecks there that content may still be sent to
 * this embedder (for example its processing region), outside any transaction.
 * `outage` says which errors from `embed` are an outage (by default an
 * `EmbedderUnavailableError`). An error from `embed` is never passed on: an
 * outage becomes a fresh `EmbedderUnavailableError`, anything else an
 * `EmbedderFailedError`, so text a provider quotes stays out of every record.
 */
export async function embedBatch(embedder: Embedder, texts: readonly string[], signal: AbortSignal,
  delays: readonly number[] = EMBED_RETRY_DELAYS_MS, admit?: () => Promise<void>,
  outage: (error: unknown) => boolean = isUnavailable): Promise<number[][]> {
  const { maxBatch, maxInputCodePoints, dimensions } = embedder.profile;
  if (texts.length < 1 || texts.length > maxBatch || texts.some(text => codePoints(text).length > maxInputCodePoints))
    throw new RangeError('Embedding batch exceeds the embedder limits');
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new EmbedderUnavailableError('Embedding time budget exhausted', { cause: signal.reason });
    await admit?.();
    if (signal.aborted) throw new EmbedderUnavailableError('Embedding time budget exhausted', { cause: signal.reason });
    let vectors: unknown;
    try { vectors = await embedder.embed(texts, signal); }
    catch (error) {
      if (!outage(error)) throw new EmbedderFailedError();
      const unavailable = new EmbedderUnavailableError();
      if (attempt >= delays.length) throw unavailable;
      try { await wait(delays[attempt], signal); } catch { throw unavailable; }
      continue;
    }
    if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some(vector => !Array.isArray(vector)
      || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))
      || vector.every(value => value === 0)))
      throw new EmbeddingRejectedError(`Embedder returned no valid ${dimensions}-dimension vector per input`);
    return vectors as number[][];
  }
}

/** Split a string into code points, the unit every projection offset uses. */
export function codePoints(text: string): string[] { return Array.from(text); }

/**
 * A code point PostgreSQL text can store: U+0000 and an unpaired surrogate
 * (both valid in a record's JSON string) become U+FFFD, one code point for
 * one, so offsets stay those of the authoritative text.
 */
const storable = (point: string) => {
  const code = point.codePointAt(0)!;
  return code === 0 || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : point;
};

/**
 * Initial chunk bounds, not measured relevance settings (STA-49 evaluates
 * them): at most 1,000 code points with 100 code points of overlap. A chunk
 * is then at most 4,000 bytes, inside the storage bound of 65,536, and fits
 * an embedder whose profile accepts 1,000 code points. A Ref's configured
 * text is at most 1 MiB, so at most about 1,200 chunks.
 */
export const CHUNK_CODE_POINTS = 1_000;
export const CHUNK_OVERLAP = 100;

export interface TextChunk {
  /** The JSON Pointer of a record field; null for source content and claim statements. */
  field: string | null;
  /** Code-point range in the projected text, end exclusive. */
  start: number; end: number;
  content: string;
}

/**
 * Chunk one text by code points. A chunk ends at the last whitespace in its
 * second half when there is one, so words stay whole, and the next chunk
 * starts `overlap` code points before that end. Whitespace-only text has no
 * chunks. Chunk content holds U+FFFD for each U+0000 or unpaired surrogate,
 * so every text authority accepts has a storable projection.
 */
export function chunkText(text: string, field: string | null, size = CHUNK_CODE_POINTS, overlap = CHUNK_OVERLAP): TextChunk[] {
  if (!Number.isSafeInteger(size) || size < 2 || !Number.isSafeInteger(overlap) || overlap < 0 || overlap >= size / 2)
    throw new RangeError('Invalid chunk bounds');
  const points = codePoints(text).map(storable);
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + size);
    if (end < points.length) {
      for (let cut = end; cut > start + size / 2; cut--) if (/\s/u.test(points[cut - 1])) { end = cut; break; }
    }
    const content = points.slice(start, end).join('');
    if (content.trim()) chunks.push({ field, start, end, content });
    if (end === points.length) break;
    start = end - overlap;
  }
  return chunks;
}

/** The parts of a retrieval policy that decide what is projected. */
export interface ContentPolicy { recordFields: readonly string[]; sourceContent: boolean; claimStatements: boolean }

/** Resolve an RFC 6901 JSON Pointer; undefined when any step is missing or the pointer is malformed. */
export function pointer(document: unknown, path: string): unknown {
  // Every `~` must start a `~0` or `~1` escape, a trailing one included.
  if ((path !== '' && !path.startsWith('/')) || /~(?![01])/u.test(path)) return undefined;
  let current = document;
  for (const raw of path.split('/').slice(1)) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/.test(token)) current = current[Number(token)];
    else if (current !== null && typeof current === 'object' && !Array.isArray(current) && Object.hasOwn(current, token))
      current = (current as Record<string, unknown>)[token];
    else return undefined;
  }
  return current;
}

/**
 * Configured text only: a record's policy-listed fields whose values are
 * strings (in policy order), a source's extraction content when source
 * content is on, a claim's statement when claim statements are on. Nothing
 * else of the Ref is ever chunked, embedded or indexed.
 */
export function configuredChunks(kind: 'record' | 'source' | 'claim', policy: ContentPolicy, content: string): TextChunk[] {
  if (kind === 'source') return policy.sourceContent ? chunkText(content, null) : [];
  if (kind === 'claim') return policy.claimStatements ? chunkText(content, null) : [];
  if (!policy.recordFields.length) return [];
  const document: unknown = JSON.parse(content);
  return policy.recordFields.flatMap(field => {
    const value = pointer(document, field);
    return typeof value === 'string' ? chunkText(value, field) : [];
  });
}

/**
 * A deterministic local embedder for tests and fixtures: signed feature
 * hashing of lowercased word tokens, L2-normalized, so texts sharing words
 * are close. It calls nothing external and is not a semantic model.
 */
export class DeterministicEmbedder implements Embedder {
  readonly profile: EmbedderProfile;
  readonly calls: string[][] = [];
  constructor(profile: Partial<EmbedderProfile> = {}) {
    this.profile = Object.freeze({ embedder: 'stateplane-local', model: 'feature-hash', modelVersion: '1', dimensions: 384,
      region: 'local', quality: 0, costPerMillionCodePoints: 0, maxBatch: 64, maxInputCodePoints: CHUNK_CODE_POINTS, ...profile });
    if (!validProfile(this.profile)) throw new RangeError('Invalid embedder profile');
  }

  async embed(texts: readonly string[], signal: AbortSignal): Promise<number[][]> {
    if (signal.aborted) throw new EmbedderUnavailableError('Embedding aborted', { cause: signal.reason });
    this.calls.push([...texts]);
    return texts.map(text => this.vector(text));
  }

  vector(text: string): number[] {
    const values = new Array<number>(this.profile.dimensions).fill(0);
    for (const token of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let hash = 0x811c9dc5;
      for (const unit of token) { hash ^= unit.codePointAt(0)!; hash = Math.imul(hash, 0x01000193) >>> 0; }
      values[hash % values.length] += (hash & 0x80000000) ? -1 : 1;
    }
    const norm = Math.hypot(...values);
    if (norm === 0) { values[0] = 1; return values; }
    return values.map(value => value / norm);
  }
}

/**
 * The reciprocal rank fusion constant. 60 is the value Cormack, Clarke and
 * Büttcher (SIGIR 2009) found robust across collections; it is not tuned
 * here (STA-49 evaluates relevance).
 */
export const RRF_K = 60;

/** One fused candidate: its key, fused score, and 1-based rank in each list (null when absent). */
export interface FusedRank { key: string; score: number; ranks: (number | null)[] }

/**
 * Reciprocal rank fusion of ranked lists of keys, best first: each key scores
 * the sum of `1 / (k + rank)` over the lists it appears in, so a key both
 * lists rank well beats one only a single list ranks first. A key counts once
 * per list, at its best rank, so duplicates (several chunks of one Ref) never
 * add up. Ties go to the better best rank, then to the earlier list, then to
 * the key, so the order is deterministic.
 */
export function fuseRanks(lists: readonly (readonly string[])[], k = RRF_K): FusedRank[] {
  if (!Number.isFinite(k) || k < 0) throw new RangeError('Invalid fusion constant');
  const fused = new Map<string, FusedRank>();
  lists.forEach((list, index) => {
    let rank = 0;
    for (const key of list) {
      let entry = fused.get(key);
      if (entry?.ranks[index] != null) continue;
      rank++;
      if (!entry) fused.set(key, entry = { key, score: 0, ranks: lists.map(() => null) });
      entry.ranks[index] = rank;
      entry.score += 1 / (k + rank);
    }
  });
  const best = (entry: FusedRank) => Math.min(...entry.ranks.map(rank => rank ?? Infinity));
  const first = (entry: FusedRank) => entry.ranks.findIndex(rank => rank !== null);
  return [...fused.values()].sort((a, b) => b.score - a.score || best(a) - best(b) || first(a) - first(b)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
