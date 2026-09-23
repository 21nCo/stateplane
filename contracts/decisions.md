# STA-2 decision record (2026-09-23)

Status: accepted logical decisions; **not** evidence of deployed infrastructure. [Contract v1](v1.md) is normative. These choices supersede the initial Turso/managed-memory architecture draft; changes require a versioned contract revision and conformance cases.

## D1 — Space ownership and placement

- A space is personally owned, independent of account identity and database placement. Resolve its cell and current grants server-side.
- Fence one writer placement per space; never expose database IDs or permit a direct-cell bypass.
- Proof: STA-6 routing/policy; STA-18 relocation.

## D2 — Authority and collection storage

- Use one fixed Postgres physical schema via cache-disabled Hyperdrive for authoritative operations. Collections are versioned registry data, not per-collection tables or tools.
- Commit row, unique reservations, audit, receipt and outbox atomically.
- Proof: STA-5 repository; STA-7 collections/mutations.

## D3 — Conditional mutations, keys and links

- Create is create-only. Existing-record writes require a revision; replace removes omitted optional fields, while patch uses explicit top-level set/unset. Reject non-applicable inputs before receipt lookup. Null is present; missing is absent.
- Generated IDs, external keys and named composite reservations occupy separate typed namespaces. Lookup selects generated or external mode, never falls back, and returns only live records even when key text collides. Existing-record mutations reject key input; tombstones reserve external and composite keys.
- Normalize external keys with NFC and the fixed Unicode White_Space edge set (including U+0085, excluding U+FEFF). Compare composite unique string components using NFC **only for reservation**, leaving stored data byte-exact; equivalent UTC date-time instants reserve one tuple.
- Link restrict/detach governs deletion of record, source or claim endpoints. A mixed policy restricts the entire delete; detach atomically tombstones incident links, never leaves live dangling links and never cascades into other endpoints. These rules prevent lost updates, namespace collisions and ambiguous resurrection.
- Proof: STA-7 record mutations; STA-13 link/source/claim adapter fixtures and create/delete races.

## D4 — Idempotency and authorization

- Receipt identity includes space, credential and operation. Fingerprint server-derived actor, canonical payload with UTF-8-byte-ordered object keys and optional caller-supplied `expectedSchemaVersion`, not the current server schema version.
- An omitted precondition means current schema; a provided version is checked only for a new write after receipt lookup. Authorize requested and original receipt collections with current operation-specific write grants before comparing fingerprints or replaying. A read grant alone never replays a write receipt.
- In space `readOnly`, reads/export remain permitted under their grants; **new writes are denied**, but a matching committed write may replay under retained write grants. Matching replay precedes stale schema/revision checks. A lost response is retryable within documented retention even after compatible additions; changed requests fail without disclosing revoked results.
- Proof: STA-5 atomic store; STA-6 policy; STA-7 mutations; STA-9/10 transports.

## D5 — Schema syntax and evolution

- Use the bounded Draft 2020-12 JSON Schema subset, not a custom DSL. Reject unknown/malformed keyword values and breaking revisions. Count string lengths as Unicode codepoints; compatibility ignores only schema-node `description` annotations, not a property named `description`.
- Integers use the inclusive binary64 safe range (±9007199254740991), because JavaScript-based JSON clients/fingerprints cannot reliably preserve larger integer identity. Finite `number` is separate from this interoperability bound.
- Only top-level optional additions are compatible in v1 after index readiness where needed; nested additions require a later migration workflow.
- Proof: STA-7 schema/compiler.

## D6 — Exact reads and consistent analysis

- Exact filtered count/exists and record status come from authority; unsupported filters fail closed. Live keyset pages bind scope/query/schema, are not snapshots, and cannot be supplied to count/exists.
- Optional sorts order missing, null, value ascending (reverse the primary order descending), with ID always ascending on ties. Export/long analysis needs a pinned consistent boundary and fetch-time authorization.
- Proof: STA-8 exact queries; STA-15 analytics; STA-17 export.

## D7 — Evidence and claims

- Sources and claims inherit one owning collection's access; links never widen it. Claims differ from records by attribution and authority, not subject matter: they are assertions, not explicit record values. Extraction never patches records.
- Proof: STA-13 evidence; STA-14 search.

## D8 — Derived projections

- Regional Postgres full-text plus pgvector projections use a replaceable embedder and generation-fenced async worker. Reauthorize and re-read each search result; report index state separately from the committed write.
- Proof: STA-12 jobs; STA-14 recall.

## D9 — Validation details

- Unique constraint names are distinct per collection; duplicates fail schema definition. Named reservations remain independent.
- Patch `unset` accepts distinct declared optional top-level fields; absent optional fields are valid no-ops. External keys, schema names/annotations and record strings must contain Unicode scalar values; unpaired surrogates fail before effects with input-specific codes.
- Collection enum-transition enforcement remains normative, outside the STA-2 in-memory oracle.
- Proof: STA-7 schema, mutation and lifecycle adapter fixtures.

## Unresolved operational selections (do not invent defaults)

| Selection / evidence still needed | Accountable issue |
| --- | --- |
| Exact published Skillplane-compatible AuthFn/McpFn/DataFn versions and runtime compatibility | STA-3 |
| Cell deployment bindings, managed Postgres host/region, Hyperdrive cache-disable validation, R2/queue/worker boundaries, jurisdiction of logs/backups and real routing identity | STA-4; STA-6 validates routing |
| Numeric row/depth/key/query/byte/rate quotas, future bulk operation contract/bounds and receipt/cursor/snapshot retention; test concurrency and conditional writes against real Postgres | STA-5, STA-7, STA-8 |
| Schema index-declaration revisions, version backfill/index readiness mechanics and fixtures before/after readiness, permitted future breaking migrations and tombstone erasure/reuse policy | STA-7 schema/index revisions; STA-8 indexed queries; STA-17 erasure |
| Referential integrity of claim source refs distinct from links, source-byte erasure timing, and mixed link-policy deletion/create-race adapter fixtures | STA-13 evidence/links; STA-17 erasure |
| Job lease/retries/dead letters and projection generation cutover proof | STA-12; STA-14 |
| Source MIME/extraction limits, original/backup retention, permission/declassification rules and blob residency | STA-13; STA-17 |
| Embedder model/version/dimensions, processing location, quality/recall evaluation and failure behavior under real load | STA-14; STA-19 |
| Snapshot isolation implementation, export manifest retention/cancel and analytical resource budget | STA-15; STA-17 |
| Fence/copy/checkpoint/rollback algorithm for moving a space | STA-18 |
| Measured capacity, SLOs, RPO/RTO, pricing, security isolation and production readiness | STA-19; STA-20 release gate |

Reference fixtures deliberately use synthetic `entries`, `label` and `state`, with no packaged customer recipe. They prove logical expectations against a reference model only. STA-5/7/8/12/14 must run the portable suite on real adapters; STA-9/10 must compare real transport envelopes and access failures. No Cloudflare, Postgres, hosted MCP, UI or external dependency qualification is claimed by a passing Node test here.
