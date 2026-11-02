# Retrieval projection storage (STA-44)

Migration `045_retrieval_projections.sql` adds the storage for rebuildable lexical and vector projections and makes authoritative evidence writes enqueue projection work. It is the first of six slices of STA-14: the embedding port and indexing worker (STA-45), hybrid search (STA-46), context bundles (STA-47), generations, rebuild and model migration (STA-48) and transport, evaluation and docs (STA-49) follow. This slice has no embedder, search, HTTP, CLI or MCP surface, and no service writes projections yet.

Projections are derived, rebuildable data. Records, sources and claims stay independently readable without them. Every projection row names the canonical Ref (space, collection, kind, ID), authoritative revision and generation it was built from, so a later search can reread and reauthorize each hit at authority and reject stale or deleted ones. No projection row is evidence that its Ref is current, readable or complete.

## Tables

| Table | Contents | Mutability |
| --- | --- | --- |
| `retrieval_policies` | Per-collection policy versions: record fields (JSON Pointers), source extraction content, claim statements, lexical and vector switches, built-in text search configuration, allowed embedding processing regions | Immutable; versions start at 1 without gaps; the highest is current |
| `vector_index_strategies` | ANN strategy per accepted embedding dimension, with its evidence | Cell reference data, seeded by the migration |
| `projection_generations` | A collection's projection build under one policy version and, for vectors, one embedder, model, model version and dimensions | `building` → `verifying` → `active` → `retired`; `building` or `verifying` may be abandoned to `retired`. Each transition stamps its own time. Kept until erasure |
| `projection_refs` | Per generation and Ref: the authoritative revision (and source extraction version) its chunks were built from, or that it was deleted | Moves forward only; a deleted Ref stays deleted; kept until erasure |
| `lexical_chunks` | A code-point range of one configured text, its content and a `tsvector` (GIN index) | Immutable; replaced by delete and insert |
| `vector_chunks` | The same Ref, revision, generation, offsets and policy, plus embedder metadata, processing region, digest of the embedded text and the embedding | Immutable; replaced by delete and insert |
| `embedding_checkpoints` | Embeddings computed outside SQL and saved before they are applied, keyed by the Ref's target revision and chunk | Immutable; removed when applied or superseded |
| `projection_deletion_receipts` | A Ref removed from one generation: revision, chunks removed, time | Immutable; kept until erasure |
| `retrieval_outbox` | One unit of projection work per source extraction, claim revision and source or claim deletion | Delivery fields only; delivery is final; kept until erasure |

Every space-scoped table carries `space_id` and its owning `collection_id`; every key path ends at `collections`. `vector_index_strategies` is cell configuration and holds no space data.

## Chunk invariants

Each chunk row carries:

- **Canonical Ref**: `space_id`, `collection_id`, `ref_kind` (`record`, `source`, `claim`), `ref_id`.
- **Authoritative revision**: `revision` (the record or `entity_refs` revision) and, for a source, `extraction_version`. A chunk references its `projection_refs` row at exactly that revision and extraction while the Ref is live, so a chunk can never sit beside a newer revision or a deletion: advancing or deleting a Ref fails while older chunks remain. `projection_refs` names an existing record or `entity_refs` row (checked at COMMIT, like `projection_heads`, so applying takes no key-share lock on authority rows).
- **Generation and policy**: `generation` and `policy_version`, which must be the generation's own policy version. A generation is built under exactly one policy version, the collection's current one when it starts, so a policy change (fields, content or regions) takes a new generation.
- **Offsets**: `chunk_index`, `content_start` and `content_end` (code points in the projected text: the record field's value, the extraction content or the claim statement), and for a source optional `source_start` and `source_end` in the original. A lexical chunk's `content` is exactly its range. A record chunk names its `field`.
- **Embedder metadata (vector only)**: `embedder`, `embedding_model`, `model_version` and `dimensions`, which must equal the generation's, the region the embedding was processed in, which the generation's policy must allow, and `content_sha256` of the embedded text. The embedding has exactly `dimensions` dimensions.

An insert trigger also refuses content the policy does not configure (an unlisted record field, source content or claim statements when switched off), a lexical chunk when lexical projection is off, a vector chunk or checkpoint when vectors are off, and any write into a retired generation. It computes `tsv` from `content` with the policy's built-in text search configuration, whatever the writer sends. Writes share-lock their generation row, so retiring a generation waits for writers already in it.

A deletion receipt needs the authoritative Ref deleted (a tombstoned record or `entity_refs` row) and no live projection of it in that generation; once recorded, the Ref cannot be projected live in that generation again, including by a rebuild into a generation that has the receipt. The receipt and a concurrent apply of the same Ref serialize on a transaction lock. A receipt covers one generation's projection rows only. It is not proof of erasure of authority rows, original bytes, other generations, WAL or backups.

## Projection work

Authoritative writes enqueue work in their own transaction, by owner-rights triggers, so no write path can skip it and a writer needs no outbox privilege:

| Authoritative write | Work |
| --- | --- |
| A new extraction version (STA-34 extract) | `source` `upsert` at the source's revision and the new extraction version |
| A claim revision: create (revision 1), revise and review (each a new revision) | `claim` `upsert` at that revision |
| A source or claim deletion (its `entity_refs` tombstone) | `delete` at the Ref's revision |

The work row records the space's placement generation at commit, as `projection_outbox` and `evidence_outbox` do. A rolled-back or refused write (for example a claim whose key loses its grants before COMMIT, migration 043) leaves no work; a replayed write inserts nothing and enqueues nothing. If the work cannot be enqueued, the authoritative write fails. Record writes already enqueue `projection_outbox` work in their transaction (migration 002), so records need no second queue. Deleting a source or claim also enqueues an `evidence_outbox` invalidation (migration 044); the retrieval queue is separate so its delivery state can be owned by the projection worker. No worker consumes `retrieval_outbox` yet; STA-45 owns delivery, backoff and degraded status. Until then, pending work accumulates with the evidence it describes and is erased with its space.

Migration 045 enqueues, for evidence written before it, each live source's latest extraction and each live claim's current revision. Deleted evidence has nothing to project.

## ANN index strategy

| Dimensions | Strategy | Parameters |
| --- | --- | --- |
| 384, 768, 1024, 1536 | HNSW partial expression index `((embedding::vector(N)) vector_cosine_ops) WHERE dimensions = N` | `m = 16`, `ef_construction = 64` |
| 3072 | Exact distance within a generation's filters, no ANN index | — |

Evidence and reasoning:

- One `vector` column holds every dimension, so each recorded dimension has its own partial expression index; [pgvector's FAQ documents this pattern](https://github.com/pgvector/pgvector) for mixed dimensions. A generation must name a recorded dimension (foreign key), so an embedder with an unrecorded dimension needs a migration that records its strategy first. A query uses the index only with the same cast and `dimensions` predicate.
- HNSW rather than IVFFlat: IVFFlat derives its lists from the rows present when the index is built, and this migration builds on an empty table; HNSW needs no training step and accepts inserts incrementally. `m = 16` and `ef_construction = 64` are pgvector's defaults, not tuned values; STA-49's relevance evaluation measures recall and latency and may record different parameters.
- pgvector 0.8 refuses HNSW and IVFFlat indexes on `vector` columns above 2,000 dimensions (observed: `column cannot have more than 2000 dimensions for hnsw index`). 3,072 dimensions is therefore exact. Indexing it would need `halfvec` or reduced dimensions, a later decision.
- Cosine distance only, matching the operator class. The integration test confirms on PostgreSQL 17 with pgvector 0.8.7 that a 384-dimension nearest-neighbour query with the index's cast and predicate plans an index scan on `vector_chunks_hnsw_384`, and that, narrowed to one space, collection and generation, the planner may instead read that generation through the primary key and rank it exactly. A filtered ANN top-k is not complete recall: STA-46 must overfetch, report underfill and never treat either plan's result as complete.

These are storage choices on small local fixtures, not capacity, latency or recall measurements.

## Bounds

Initial storage bounds, chosen for bounded rows and validation, not measured provider limits: up to 32 record fields per policy, each a JSON Pointer of at most 256 bytes; up to 16 processing regions, each a lowercase label of at most 63 characters; lexical chunk content of at most 65,536 bytes (well inside PostgreSQL's 1 MB `tsvector` limit); embedder name up to 64 characters and model and model version up to 256 bytes; work errors up to 1,024 bytes. Chunk size, overlap and embedding batch limits belong to STA-45's chunker and embedder and need measurement there.

## Upgrade, restore and grants

Migration 045 takes share row exclusive locks on `collections`, `records`, `entity_refs`, `extraction_versions` and `claim_revisions` up front, within the migrator's five-second bounded wait; a writer holding them makes it fail and roll back completely (no table, trigger, ledger row or purge change), and a retry applies it. It creates empty tables and indexes and scans only evidence tables for the enqueue backfill, so a populated upgrade needs no drained-traffic flag. There is no down migration, as for every migration in this repository: the forward step is one transaction, and recovery from a bad deploy is restore.

`stateplane_purge_space` now removes every space-scoped retrieval row before the records, identities and collections it references, and the space erasure report (`PostgresSpaces.erasure`) reads every retrieval table before reporting the database erased.

Run `pnpm db:grant-retrieval` after migration 045 and after every restore. It grants the cell operational role `SELECT` on every retrieval table (space deletion reads them to prove erasure); `INSERT` on `retrieval_policies`; `INSERT, UPDATE` on `projection_generations` and `projection_refs`; `INSERT` on `projection_deletion_receipts`; `INSERT, DELETE` on `lexical_chunks`, `vector_chunks` and `embedding_checkpoints`; `UPDATE` on `retrieval_outbox`; and `EXECUTE` on `public.vector(public.vector, integer, boolean)`. The last is needed because an HNSW index casts each inserted embedding to its dimension and PostgreSQL checks `EXECUTE` on that cast function for the inserting role; the [regional runbook](regional-topology.md) revokes `PUBLIC` execution of public-schema routines, and without the grant a vector insert fails with `permission denied for function vector`. No grant allows `DELETE` or `TRUNCATE` of policies, generations, projected Refs, receipts or work: removal stays with the scoped purge routine. Policy validation runs in triggers, so writers need no other routine grant.

## Verification

`node --test test/integration/retrieval-projections.test.js` (part of `pnpm test:postgres`) covers enqueueing through the real source and claim services (extract, claim create, replayed create, revise, review, claim and source deletion), rollback atomicity, delivery-only updates, policy validation and immutability, generation transitions and the single active and pending generation, chunk and checkpoint constraints, Ref ordering and deletion receipts, the HNSW indexes and plans, space purge isolation, the erasure report, a nonowner cell role with and without the grants under the runbook's routine revocation, and the atomic, retryable upgrade with its backfill and an upgraded schema equal to a fresh one. `pnpm db:restore-smoke` restores a populated row in every retrieval table and checks the restored triggers, Ref fence, deletion receipt, HNSW indexes and grants; `pnpm db:upgrade-smoke` applies 045 to a populated upgrade and checks the purge's index plans. These are local PostgreSQL 17 + pgvector 0.8.7 checks; Railway Postgres acceptance is listed in the pull request.
