# Stateplane architecture

Status: contract design v1, 2026-09-23. This repository is a design and executable contract harness, **not** a deployed service. The normative behavior for implementers is [contracts/v1.md](contracts/v1.md), with rationale and deferred decisions in [contracts/decisions.md](contracts/decisions.md). `node --test` runs generic conformance fixtures against a reference model; adapters must pass the same cases against their real authority before claiming compliance.

## Product boundary

Stateplane owns personally owned, shared mutable state and evidence, not an agent workflow engine or integration executor. Skillplane owns versioned capabilities; integration runtimes own third-party actions. One account can own multiple spaces; each space has a stable logical ID, one owner, collection-scoped grants, lifecycle and policy version, a home cell and an independently movable storage placement. An account identity is not a space ID; a home cell is not a credential; neither is a physical database address a public ref. The owner grants agent credentials only the required capabilities. No client-supplied space selector or cell URL is an authorization assertion.

The product is generic: ordinary collections and bounded validated JSON records, not customer-domain tables, recipes or tools. Records contain explicitly written authoritative values; claims contain attributed assertions and review status regardless of subject. In particular status, membership, count and completeness require exact authoritative reads. Search and extraction cannot write records implicitly. MCP, HTTP, CLI and UI use the same application services and policy checks.

## Regional topology

```text
Global app/API/MCP entry points (identity + server-side placement lookup)
              | signed, audience-bound, short-lived routing context
              v
      one selected regional serving/storage cell
        application service + policy/schema registry
        Postgres authority <-- cache-disabled Hyperdrive --> service
        Postgres native full-text + pgvector (rebuildable projections)
        durable SQL outbox/jobs -> dispatcher -> cell workers
        independently configured R2 originals/exports
        interchangeable embedder (outside SQL transactions)
```

The control plane holds minimal identity, routing and placement metadata, not the records or original bytes. Each regional cell has its own serving service, Postgres authority, projection tables, outbox, workers, blob binding and HTTP/MCP entry paths; SvelteKit/Svelte + Tailwind UI and CLI consume the same API. Initially many spaces share the database **within their cell**, with `space_id` on every authority/query boundary. Dedicated per-space database placement and controlled relocation are later work. Routing assertions carry space ID, destination/audience and placement generation, are validated by the cell, and are fenced again at mutation commit. Expiry/key rotation and grant revocation must not be masked by global caches. Cache-disabled Hyperdrive paths are required for fresh permission checks, exact reads, conditional writes and receipt replay; application writes do not imply query-cache invalidation.

A regional label is not proof of data residency. Select and test the real Postgres host, R2 location, queue/worker, embedder processing, telemetry and backup policies per cell. There is one writer placement per space; no active-active write, automatic cross-jurisdiction failover or unrestricted replication promise. Regional outage behavior fails closed where placement policy disallows alternatives.

## Authority and projections

Use a fixed physical schema: accounts/principals/credentials, spaces/grants/placements, collections/schema versions, records/unique reservations/typed field indexes, sources/immutable originals, links, attributed claims, change events, idempotency receipts, tombstones, projection outbox/jobs and generation receipts. Defining a collection inserts registry data; it does not provision a table, database or MCP tool. Each write commits its authority row, reservations, typed index, immutable audit fact, receipt and outbox entry atomically. Delivery state is mutable separately from audit. Unsupported transaction semantics fail qualification; a best-effort sequence is not a repository adapter.

Native Postgres full-text and pgvector are **derived**, rebuildable indexes; an interchangeable embedding port maps text to model/version/dimension. Chunk metadata includes canonical ref, source offset, authority revision, policy and projection generation. Embedding is outside the write transaction. Duplicate/reordered outbox delivery, old results and deletions cannot activate stale revisions. Search overfetches candidate refs, deduplicates them, then rereads and reauthorizes at authority; an underfilled filtered ANN top-k is not complete recall. Pending/degraded indexing is explicit; exact reads work without the embedder. A rebuild creates a new generation and cuts over only after verification. Optional future memory vendors are adapters, never a second authority.

Original source bytes are immutable and digest-verified; a reference-only source explicitly says it was not fetched. Upload grants bind actor, space, size and type, and finalize reauthorizes; failed metadata commits leave reconciled orphan blobs. Claims keep attribution, evidence and unreviewed/accepted status. A claim cannot become an authoritative record via extraction; conflicting claims coexist. Source and claim access is scoped to one owning collection; links never confer access. Evidence from restricted material cannot be relinked to widen readership; explicit declassification is deferred. Deleting an authority ref tombstones it before asynchronous index/blob removal; an index deletion acknowledgment is not proof of full erasure or backup expiration.

## Public operations and lifecycle

A fixed generic catalog supports space discovery, collection definitions, create/replace/patch/delete and exact get/query/count/exists, bounded sources/claims/links/events, contextual search/bundles, projection status, bounded bulk and export/analysis jobs. No arbitrary SQL, unrestricted joins, uploaded code, or per-collection tools. Existing-record writes require `expectedRevision`; retry receipt matching and current authorization precede revision checks. See the versioned contract for key normalization, uniqueness, tombstones, schema compatibility, cursor/snapshot semantics and errors. Live keyset pages are not a snapshot; full exports and long analysis require a consistent pinned boundary. Outputs include revision, provenance and projection freshness, not fictitious immediate index completion.

Export manifests preserve canonical IDs/revisions, schemas, provenance, digests, links, grants/policy mapping, audit and a consistency boundary, but not secrets. Restore maps principals explicitly, reissues credentials and rebuilds projections; erased refs cannot resurrect. Relocation to dedicated storage needs checkpoint/catch-up or write freeze, generation fencing, validation and rollback limits. Those mechanisms and numeric recovery objectives are not yet implemented or promised.

## Package and operations policy

Qualify exact published Skillplane-compatible AuthFn/McpFn versions before integrating identity and Streamable HTTP MCP; AuthFn supplies identity/session/key primitives, while Stateplane owns space grants and policy. DataFn/DB may be reused only if a real target adapter passes transactional/revision tests. No changes to Superfunctions or Skillplane are authorized here. Use TypeScript/pnpm/Cloudflare conventions only after checking actual consumer packages and deployment topology. Bounds on rows, depth, query work, blobs, extraction, concurrency, rate, retention and retries require measured configuration; no capacity, price, SLO, RPO/RTO, deployment or vendor readiness is claimed by this document.

## Delivery gates

1. STA-2 fixes the logical contract and a generic reference conformance harness (this work).
2. Subsequent issues qualify packages and regional infrastructure, implement Postgres authority, identity/policy, collection/query/transport behavior and demonstrate two real MCP clients with revocation and stale/replay semantics before recall.
3. Later issues implement sources/claims, durable outbox, Postgres search/vector, bounded analytics, UI, export/restore/erasure, dedicated placement/relocation and measured release acceptance. See [decisions](contracts/decisions.md) for accountable unresolved choices; unit fixtures are not evidence of hosted deployment.

Technical background: [Cloudflare Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/), [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [PostgreSQL text search](https://www.postgresql.org/docs/current/textsearch.html), [pgvector](https://github.com/pgvector/pgvector). Provider capabilities and residency still require qualification against the actual deployment.
