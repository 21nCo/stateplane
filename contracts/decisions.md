# STA-2 decision record (2026-09-24)

Status: accepted logical foundation, not evidence of deployed infrastructure. [Contract v1](v1.md) is normative. These choices supersede the initial Turso/managed-memory architecture draft. Incompatible changes require a versioned contract and new conformance cases; downstream mutation and query decision records must not override these invariants implicitly.

| ID | Decision and reason | Downstream proof owner |
| --- | --- | --- |
| F1 | A space is one personally owned logical container; account/principal identity, owner, grants, home cell and physical placement are separate. A placement generation and policy version fence routing and commit; public refs survive relocation. No active-active or cross-jurisdiction failover promise. | STA-6 routing/policy; STA-18 relocation |
| F2 | One fixed physical schema in each regional Postgres authority accessed through cache-disabled Hyperdrive for policy-sensitive and authoritative paths. Collections are versioned registry data, not tables/tools/databases. Native full-text and pgvector are rebuildable projections, with a replaceable embedder outside transactions. | STA-4 topology; STA-5 repository; STA-12 outbox; STA-14 recall |
| F3 | Published collection syntax is bounded Draft 2020-12 JSON Schema, not an undocumented DSL. Unsupported/malformed keywords fail at definition; first compatible revisions add top-level optional fields or annotations, with typed index readiness before query exposure. Nested optional additions and changed validation/uniqueness/lifecycle rules need migration. | STA-7 schema/compiler, lifecycle and backfill; STA-8 indexed query readiness |
| F4 | `integer` uses the inclusive IEEE-754 safe range for JSON interoperability; string lengths are codepoint counts; explicit null is distinct from missing. Unique-constraint names must be distinct in a collection and paths must be declared top-level scalar names. A composite unique comparison uses NFC-normalized string components *without changing stored record data*; canonical-equivalent strings collide deliberately. This resolves the old-head mismatch between unnormalized data and normalized uniqueness: the normalization boundary is the reservation, not the record. | STA-7 adapter and compiler; STA-5 reservation atomicity; STA-8 exact query distinguishes original values |
| F5 | Authorization is current credential plus collection-grant plus lifecycle/policy; link/search/provider tags do not expand access. A read-only space can expose an already committed receipt only through a currently authorized replay under its original write grant. | STA-6 policy; STA-5 receipts; STA-7 mutations; STA-13 evidence; STA-9/10 transports |

## Composite-normalization regression criterion

Against the pre-remediation STA-2 PR head, the contract says user data is not normalized but the reference oracle normalizes string components of composite unique tuples. A pair of create-only records in one space/collection with distinct external keys and `label` values `"é"` (U+00E9) and `"e\u0301"` (U+0065 U+0301) is the minimal observable case: the first committed data must remain `"é"`, the second must fail `UNIQUE_CONFLICT` while the stored spelling of the first remains unchanged. Changing to distinct spaces or collections must not conflict. Repair requires the normative wording above, corresponding oracle/adapter behavior and generic conformance fixtures to be aligned together; do not fix by normalizing record data or by dropping NFC from the uniqueness index without a versioned decision. STA-7 owns the executable oracle/real-adapter cases, and the PR convergence owner must record old-head failing evidence and repaired-head results in its external ledger. This contract-only task does not claim to have run that oracle or Postgres.

## Unresolved operational selections (no fabricated defaults)

| Evidence still needed | Accountable issue |
| --- | --- |
| Qualified published Skillplane-compatible AuthFn/McpFn/DataFn versions and runtime | STA-3 |
| Actual cell bindings, managed Postgres host/region, Hyperdrive cache-disable test, R2/queues/workers, backup/log jurisdiction and routing identity | STA-4; STA-6 routing |
| Numeric payload/depth/key/query/byte/rate/bulk budgets and receipt/cursor/snapshot retention, concurrency on real Postgres | STA-5; STA-7; STA-8 |
| Typed-index evolution/backfill and readiness, future breaking migration, tombstone erasure/key reuse | STA-7; STA-8; STA-17 |
| Source byte residency/retention, claim-source integrity and link deletion behavior on real storage | STA-13; STA-17 |
| Job lease/retries/dead letters and generation cutover | STA-12; STA-14 |
| Embedder model/version/dimensions, processing jurisdiction, recall quality and real-load failure | STA-14; STA-19 |
| Snapshot isolation, manifest retention/cancel and analysis resource budget | STA-15; STA-17 |
| Space move fence/checkpoint/rollback algorithm | STA-18 |
| Measured capacity, SLOs, RPO/RTO, pricing, security and production readiness | STA-19; STA-20 |

A passing local syntax check or reference suite is not proof of hosted Postgres/Hyperdrive, Cloudflare regional behavior, source/blob residency or transport conformance. The downstream issues own those validations.
