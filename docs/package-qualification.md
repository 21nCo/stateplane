# Published package qualification for STA-3

Observed 2026-09-26 using npm registry versions and export maps from packages installed by `pnpm install` into this workspace. `node scripts/qualify-exports.mjs` checks every declared runtime and type target in the installed packed artifacts and imports each package root. `pnpm test:consumer` packs Stateplane packages and imports/typechecks them from an isolated npm consumer. No Superfunctions or Skillplane worktree was modified.

| Package | Version | Packed export paths | Observed runtime evidence | Decision |
| --- | --- | --- | --- | --- |
| `@authfn/core` | 0.1.1 | `.` | Node import; composed schema and API-key create/auth/revoke test; Worker bundle probe | Qualifies as identity/session primitive, not space authorization |
| `@authfn/api-keys` | 0.1.2 | `.` | Node plugin composition and revocation denial; Worker bundle probe | Qualifies for key primitive; Stateplane grant binding pending |
| `@authfn/multi-region` | 0.1.2 | `.` | Node plugin composition and in-memory stale-epoch compare-and-set rejection; Worker bundle probe | Identity placement only; Stateplane space placement/fencing remains separate |
| `@mcpfn/core` | 0.0.5 | `.` (import and require) | Manifest and in-memory protocol list/call test; Worker bundle probe | Qualifies as MCP protocol primitive; no hosted transport proven |
| `@mcpfn/auth` | 0.0.5 | `.` (import and require) | Bearer challenge parsed by testing package; Worker bundle probe | Qualifies as resource-auth primitive; Stateplane policy still required |
| `@mcpfn/testing` | 0.0.5 | `.`, `./auth`, `./playwright` (import and require) | Node in-memory protocol client and `./auth` challenge parser; Node-only package has `child_process` dependency and is excluded from Worker | Use in tests only |
| `@datafn/core` | 0.1.1 | `.`, `./types`, `./capabilities`, `./errors`, `./relations`, `./sort`, `./namespace-storage` | Fixed schema validation and external consumer; Worker bundle probe | Qualifies for fixed read-model schema |
| `@datafn/server` | 0.2.0 | `.`, `./placement` | Node import and Worker bundle probe; no transactional Postgres test | Server integration deferred; no runtime collection authority |
| `@superfunctions/db` | 0.2.1 | `.`, `./adapters`, `/drizzle`, `/memory`, `/cloudflare-kv`, `/cloudflare-do`, `/redis`, `/dynamodb`, `./observability`, `./testing`, `./types` | Memory rollback test, packed path verification, Worker bundle probe | No qualification for Postgres atomic record/audit/outbox contract |
| `@superfunctions/storage-r2` | 0.2.0 | `.` | Node import and Worker bundle probe only | Conformance pending before use for originals |
| `@superfunctions/observability` | 0.0.1 | `.`, `./node` | Node import and Worker bundle probe of root | Conformance pending before use for audit/telemetry |

The package `authfn@0.3.0` is a published transitive dependency of the AuthFn plugin packages; imports resolve from packed releases rather than a same-version checkout. The McpFn testing artifact bundles Node test-runner dependencies, so it must never be a Worker runtime dependency. `pnpm worker:package-dry-run` proves bundling with `nodejs_compat`, not request-time operation or external provider behavior.

## Missing qualification and explicit owners

1. **STA-5 Postgres authority:** prove one actual Postgres transaction covers conditional revision, unique reservation, record, audit, receipt and outbox, with rollback and concurrent retries. The published shared DB `Adapter.transaction` supports callbacks and the memory adapter passes rollback, but that is insufficient for the v1 authority contract. Stateplane owns this repository implementation and fixed SQL migrations until the exact adapter meets the test. No sequential fallback is allowed.
2. **STA-4 identity and placement:** connect AuthFn user/session/key records to Stateplane credential grants, current authorization and placement generation at request start and commit. AuthFn multi-region identity routing cannot stand in for a space's storage placement.
3. **STA-9/10 transport:** run McpFn HTTP protocol and auth regression suites against a deployed cell, including revocation, malformed requests, retry and two real clients. Manifest construction and a bearer challenge alone do not establish this.
4. **STA-11/12 source and retrieval:** qualify R2 helper semantics, digest verification, failed metadata cleanup, projection retry and observability redaction before using helpers in authority paths.
5. **STA-3 external acceptance:** Railway Postgres migration/readback, isolated Cloudflare Preview Worker and R2 binding, and Aside Browser UI/health observation require exact-head evidence in the configured order. No connected provider sandbox is exercised by this scaffold; AuthFn external provider flows are a later identity issue. Local unit, bundle and Docker results are recorded separately from these gates.

No numeric storage, query, retry, rate or recovery limit is inferred from package versions or a green local test. The local port, image major, and connection timeout are bootstrap settings only.
