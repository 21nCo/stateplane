# STA-2 decision record (2026-09-23)

Status: accepted logical decisions; **not** evidence of deployed infrastructure. [Contract v1](v1.md) is normative. These choices supersede the initial Turso/managed-memory architecture draft; changes require a versioned contract revision and conformance cases.

| ID | Decision and reason | Downstream proof owner |
| --- | --- | --- |
| D1 | A space is a personally owned container, independent of account identity and database placement. Resolve cell and enforce current grants server-side; one fenced writer placement per space. Avoid public database IDs and direct-cell bypass. | STA-6 routing/policy; STA-18 relocation |
| D2 | One fixed physical schema in Postgres via cache-disabled Hyperdrive for authoritative operations; collection is versioned registry data. No per-collection table/tool. Atomic row + unique reservations + audit + receipt + outbox. | STA-5 repository; STA-7 collection/mutations |
| D3 | Create-only and mandatory revision checks on existing records. Replace removes omitted optional fields; patch is explicit top-level set/unset. Null is present; missing is absent. Generated IDs, external keys and named composites use separate typed namespaces; existing mutations reject key input, tombstones reserve external/composite keys, and equivalent UTC date-time instants reserve one tuple. Link restrict/detach, no record cascades. Prevent lost updates, accidental namespace collisions and ambiguous resurrection. | STA-7 mutations |
| D4 | Receipt identity includes credential and operation in space; fingerprint includes server-derived actor, canonical payload and optional caller-supplied `expectedSchemaVersion`, not the current server schema version. Omitted precondition means current schema; provided version is checked only for a new write after receipt lookup. Current authorization precedes receipt lookup, matching replay precedes stale schema/revision checks. A lost response is safe to retry within documented retention even after compatible schema additions; changed request is an error. Prevent duplicate effects without leaking revoked results. | STA-5 atomic store; STA-6 policy; STA-7 mutations; STA-9/10 transports |
| D5 | Draft 2020-12 JSON Schema bounded subset, reject unknown keywords and breaking revisions; optional additions only after indexing readiness. No custom DSL whose translation might silently diverge. | STA-7 schema/compiler |
| D6 | Exact count/exists and record status from authority. Live keyset pages bind scope/query/schema and are not complete snapshots. Export/long analysis uses pinned consistent boundary and fetch-time authorization. | STA-8 exact queries; STA-15 analytics; STA-17 export |
| D7 | Sources and claims inherit one owning collection access; links never widen it. Claims are attributed, not less authoritative because of subject matter but because they are assertions not explicit record values. Automatic extraction never patches records. | STA-13 evidence; STA-14 search |
| D8 | Regional Postgres full-text + pgvector projections, replaceable embedder, generation-fenced async worker; reauthorize and re-read every search result. Index state is reported separately from committed write. | STA-12 jobs; STA-14 recall |

## Unresolved operational selections (do not invent defaults)

| Selection / evidence still needed | Accountable issue |
| --- | --- |
| Exact published Skillplane-compatible AuthFn/McpFn/DataFn versions and runtime compatibility | STA-3 |
| Cell deployment bindings, managed Postgres host/region, Hyperdrive cache-disable validation, R2/queue/worker boundaries, jurisdiction of logs/backups and real routing identity | STA-4; STA-6 validates routing |
| Numeric row/depth/key/query/byte/rate/bulk quotas and receipt/cursor/snapshot retention; test concurrency and conditional writes against real Postgres | STA-5, STA-7, STA-8 |
| Schema version backfill/index readiness mechanics, permitted future breaking migrations and tombstone erasure/reuse policy | STA-7; STA-17 for erasure |
| Job lease/retries/dead letters and projection generation cutover proof | STA-12; STA-14 |
| Source MIME/extraction limits, original/backup retention, permission/declassification rules and blob residency | STA-13; STA-17 |
| Embedder model/version/dimensions, processing location, quality/recall evaluation and failure behavior under real load | STA-14; STA-19 |
| Snapshot isolation implementation, export manifest retention/cancel and analytical resource budget | STA-15; STA-17 |
| Fence/copy/checkpoint/rollback algorithm for moving a space | STA-18 |
| Measured capacity, SLOs, RPO/RTO, pricing, security isolation and production readiness | STA-19; STA-20 release gate |

Reference fixtures deliberately use synthetic `entries`, `label` and `state`, with no packaged customer recipe. They prove logical expectations against a reference model only. STA-5/7/8/12/14 must run the portable suite on real adapters; STA-9/10 must compare real transport envelopes and access failures. No Cloudflare, Postgres, hosted MCP, UI or external dependency qualification is claimed by a passing Node test here.
