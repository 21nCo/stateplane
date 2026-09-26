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
- For ordinary envelopes, authorize an own requested target first, then validate/snapshot the undecorated own-data mutation envelope before receipt lookup. Reject inherited dispatch/ID fields, accessors, hidden or symbol fields and extra fields as `INVALID_ARGUMENT`; never let create consult an inherited ID or overwrite a row.
- Own data target descriptors may be hidden: extract their values without getters, authorize the requested collection, then reject their nonenumerable envelope shape. After revocation a hidden own target is `FORBIDDEN`, not a pre-authorization shape error.
- An in-process proxy envelope has no trustworthy target: reject it as `INVALID_ARGUMENT` before reflective reads or traps, on both fresh writes and committed retries, without effects or receipt disclosure. Preserve authorization-before-shape for ordinary own-data targets.
- D3's in-process guarantee is conditional on a trap-free proxy detector in the accepting runtime (the Node oracle uses `node:util` `types.isProxy`). An adapter without one must accept serialized JSON bytes parsed into ordinary data, **not** arbitrary caller-supplied object instances or a serialization attempt on them. Apply this boundary to definition inputs and nested payloads as well as envelopes; parsed transport inputs still require ordinary target authorization and envelope/payload validation. STA-7 qualifies application/repository entrypoints; STA-9/10 prove HTTP/MCP/CLI decoding and error/authorization behavior. The Node fixture is not portability proof for another runtime.
- Generated IDs, external keys and named composite reservations occupy separate typed namespaces. Lookup selects generated or external mode, never falls back, and returns only live records even when key text collides. Existing-record mutations reject key input; tombstones reserve external and composite keys.
- Normalize external keys with NFC and the fixed Unicode White_Space edge set (including U+0085, excluding U+FEFF). Compare composite unique string components using NFC **only for reservation**, leaving stored data byte-exact; equivalent UTC date-time instants reserve one tuple.
- Collection unique descriptor/paths and sortable declarations are dense undecorated JSON arrays; descriptor objects have exactly own enumerable data fields `name` and `paths`. Validate and snapshot descriptors before checking names or cloning; malformed definitions fail `SCHEMA_UNSUPPORTED` before creation. Grant capability lists are likewise dense undecorated ordinary arrays; malformed tokens fail `INVALID_ARGUMENT` before policy changes. RFC3339 UTC includes actual IERS-announced positive leap seconds; preserve chronological order and fractional equivalence across record validation, reservations and typed sorts (STA-7/8 update the leap table).
- UTC validation and synthetic `createdAt` generation use captured Date operations after module initialization. A later Date prototype, static UTC, or global binding change cannot affect invalid-date rejection, valid leap-second handling, unique reservations, sorted cursors or generated timestamps; STA-7/8 qualify the corresponding adapter boundary.
- Numeric predicates and the safe-integer bound used by the reference oracle are captured before caller input. Later changes to `Number.isFinite`, `Number.isInteger` or `Number.isSafeInteger` cannot change schema bounds, JSON/record validity, UTC rejection, revision preconditions or query limits; invalid writes remain effect-free and receipt replay retains its precedence.
- Link restrict/detach governs deletion of record, source or claim endpoints. A mixed policy restricts the entire delete; detach atomically tombstones incident links, never leaves live dangling links and never cascades into other endpoints. These rules prevent lost updates, namespace collisions and ambiguous resurrection.
- Proof: STA-7 record mutations; STA-13 link/source/claim adapter fixtures and create/delete races.

## D4 — Idempotency and authorization

The D3 target/envelope snapshot uses own data slots rather than ordinary-object assignment that an inherited setter could swallow. Key validity and string bounds scan actual UTF-16 code units through a trusted reader captured before caller input; later inherited `String.prototype.charCodeAt` or iterator changes cannot alter surrogate validation, scalar counts or White_Space trimming. NFC conversion for external keys and composite string reservations uses one captured normalizer. Key trimming, UTC parsing, fractional sort comparison and cursor syntax checks use trusted string and regex operations captured before caller input, so later inherited method changes cannot alter keys, reservations or cursor ordering. `RegExp.prototype.test` delegates to the current `exec`; the oracle uses its captured matcher for UTC and cursor decisions. A mutable `codePointAt` replacement would reopen the scalar issue. Authorization and exact committed replay retain their established precedence. STA-7 proves the corresponding adapter boundary, not this in-memory oracle alone.

- Receipt identity includes space, credential and operation. Fingerprint server-derived actor, canonical payload with UTF-8-byte-ordered object keys and optional caller-supplied `expectedSchemaVersion`, not the current server schema version.
- An omitted precondition means current schema; a provided version is checked only for a new write after receipt lookup. Authorize requested and original receipt collections with current operation-specific write grants before comparing fingerprints or replaying. A read grant alone never replays a write receipt.
- Only JSON-compatible operation payloads participate in a fingerprint or receipt replay. Reject recursively invalid data/set as `SCHEMA_INVALID` and malformed patch shape as `INVALID_ARGUMENT` before fingerprinting, including same-key retries; authorize both requested and original receipt collections first. Current-schema and stale-revision checks remain after committed replay, so compatible additions do not invalidate a valid retry.
- Reject present but inapplicable fields even if their in-process value is `undefined`; reject undefined optional key/schema preconditions rather than alias omission. Reject custom-prototype arrays recursively and fingerprint verified own array elements without invoking caller-controlled methods. Neither a fresh invalid write nor an invalid retry may create or disclose a receipt.
- In-process proxies of JSON-shaped data are not stable JSON payloads: reject them recursively, including committed retries, before cloning or fingerprinting. Patch `set` shape errors remain `INVALID_ARGUMENT`; record data errors remain `SCHEMA_INVALID`. No raw clone exception is a contract error.
- In space `readOnly`, reads/export remain permitted under their grants; **new writes are denied**, but a matching committed write may replay under retained write grants. Matching replay precedes stale schema/revision checks. A lost response is retryable within documented retention even after compatible additions; changed requests fail without disclosing revoked results.
- After target authorization and operation input checks, receipt lookup distinguishes fresh requests from committed retries. In `readOnly`, a fresh request fails `SPACE_UNAVAILABLE` before data/set or patch-shape validation; an authorized committed retry validates JSON/patch shape before fingerprint comparison and replay. Active fresh writes still validate payloads. Existing-record mutations require a nonempty well-formed string ID before receipt lookup; malformed IDs fail `INVALID_ARGUMENT`. Valid unknown IDs fail `NOT_FOUND` only when no receipt identity exists; an existing identity first yields matching replay or `IDEMPOTENCY_MISMATCH` after current authorization and payload validation.
- Proof: STA-5 atomic store; STA-6 policy; STA-7 mutations; STA-9/10 transports.

## D5 — Schema syntax and evolution

- Use the bounded Draft 2020-12 JSON Schema subset, not a custom DSL. Reject unknown/malformed keyword values and breaking revisions. Count string lengths as Unicode codepoints; compatibility ignores only schema-node `description` annotations, not a property named `description`.
- A schema `type` is a single type-name string or exactly the two-member nullable scalar union; reject singleton arrays (including child object/array nodes) as `SCHEMA_UNSUPPORTED` at define/revise without effects.
- Present optional keywords with `undefined` are malformed, not absent. Validate all definition nodes as JSON-compatible before define/revise comparison; reject without effects as `SCHEMA_UNSUPPORTED`.
- Root `$schema`, every node's `type` and every object node's `additionalProperties:false` must be own supplied keywords. Ignore inherited keyword values throughout definition/revision validation and compatibility, including when a caller's prototype is polluted; absent own mandatory keywords fail `SCHEMA_UNSUPPORTED` before effects.
- Stored schema consumers also read optional keywords as own fields: post-definition prototype pollution cannot change ordinary string reservations, record acceptance, patch unset eligibility, sort order or keyset continuation. An absent own `required` list remains absent despite an inherited list or getter, while own required fields remain protected; explicit own `format:"date-time"` still validates and compares UTC instants. STA-7/8 must prove this for real adapters.
- Integers use the inclusive binary64 safe range (±9007199254740991), because JavaScript-based JSON clients/fingerprints cannot reliably preserve larger integer identity. Finite `number` is separate from this interoperability bound.
- Nonnegative integer length/item schema bounds do not inherit the record `integer` safe-range restriction; independently configured resource budgets may constrain definitions after evidence is gathered. Proxied schema nodes, arrays and declaration descriptors fail `SCHEMA_UNSUPPORTED` before persistence or revision.
- Only top-level optional additions are compatible in v1 after index readiness where needed; nested additions require a later migration workflow.
- Treat schema-node `required`, `enum`, and nullable `type` members as unordered sets for compatibility; keep array data and array enum *values* ordered. Membership or constraint changes still fail as breaking.
- Traverse verified own indexed array values for item validation, enum definition/revision, schema paths, grants and unique reservations, not later inherited iterators or methods. Construct internal arrays with own data slots so an inherited numeric setter cannot erase schema compatibility members, canonical fingerprints, reservations or events. Prototype pollution cannot skip invalid members, weaken grants, remove a duplicate unique tuple or admit a breaking revision; rejections leave authoritative state and receipts untouched. Receipt fingerprint comparison still precedes current-schema validation on a committed retry.
- Internal Set construction from mutation field-name arrays uses verified own slots; empty trusted Map/Set constructors and Map entry-pair consumers never expand or destructure through a later inherited Array iterator. The old head accepted forbidden and present-undefined mutation fields, and could skip reservation release or projection rebuild when that iterator changed. Rejected writes leave records, reservations, events, outbox, receipts and sequence unchanged.
- The oracle also pins its Map and Set operations before caller input. Canonical schema sets, grants, committed receipt lookup, reservation release, record reads, cursors and projection rebuild traverse actual entries after later inherited iterator/method changes. A required-field removal remains breaking and a replacement releases its former live unique tuple; old-head probes showed both failures under an empty Map iterator. STA-7/8 own the equivalent adapter proof.
- Proof: STA-7 schema/compiler.

## D6 — Exact reads and consistent analysis

The reference cursor checks canonical wire bytes and binding, then validates a fixed-length lowercase hex HMAC and compares its bytes with a constant-time primitive; malformed or altered signatures fail `CURSOR_INVALID`. STA-8 owns production adapter verification; no timing measurement or deployed implementation is claimed here.

- Exact filtered count/exists and record status come from authority; unsupported filters fail closed. Live keyset pages bind scope/query/schema, are not snapshots, and cannot be supplied to count/exists.
- A signed cursor is accepted in one emitted wire representation, not reconstructed from alternate JSON spellings of the same binding. The in-memory oracle checks exact UTF-8 JSON envelope bytes and canonical unpadded base64url before validating the signature; real adapters may choose another opaque authenticated encoding but reject aliases and authorize before decoding.
- Optional sorts order missing, null, value ascending (reverse the primary order descending), with ID always ascending on ties. A missing field must be ranked by own-property absence without reading an inherited value or invoking a prototype getter, including when computing cursor tuples; explicit null and present values are distinct. Export/long analysis needs a pinned consistent boundary and fetch-time authorization.
- After read authorization, an in-process sort descriptor is an undecorated ordinary object with exactly own enumerable data `field` and `direction`; reject accessors, inherited/hidden/symbol/extra keys and proxies without invoking caller traps. Snapshot both values once, validate the allowlist, and reuse only the snapshot for comparison and signed cursors in query/count/exists. Non-Node adapters require a proven trap-free proxy guard or serialized-JSON-only input; count/exists cursor rejection remains unchanged.
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
