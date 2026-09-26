# Stateplane foundation

Stateplane is a generic owned-state service under construction. [The v1 logical contract](contracts/v1.md) is normative; this checkout currently supplies a Cloudflare/SvelteKit foundation, package boundaries, a fixed read-model schema, and qualification probes. The `/api/health` route reports `scaffold`, not operational state readiness.

## Fresh checkout

Use Node 22.13+ (below 25), pnpm 11.9.0, and Docker with Compose. These versions follow the verified local Skillplane workspace conventions; this repository has its own lockfile, database volume, R2 binding, and secrets. Do not copy Skillplane environment files or resource IDs.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm db:up
pnpm db:migrate
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm check` runs lint and boundary checks, typecheck, the STA-2 contract fixture suite, focused published package tests, builds, isolated packed-package consumer, and both Worker dry-runs. The package probe bundles production packages into a Worker; the Node-only McpFn testing package is excluded. CI installs Chromium with system dependencies. Use `pnpm db:down` after local testing; it retains the disposable database volume and local credential for the next run.

Local Worker/R2 development: `pnpm dev:worker`. Wrangler persists its local emulated R2 state in `.data/wrangler/app`. The local binding is `ORIGINALS` and its bucket name is `stateplane-originals-local`; no Cloudflare account or shared R2 resource is used by `wrangler dev`. `pnpm --filter @stateplane/app dev` runs Vite without Worker bindings for UI work. A remote Cloudflare Preview, Hyperdrive, and a real regional R2 bucket are later acceptance boundaries, not results of local development.

The isolated Postgres service binds only `127.0.0.1:55432` and uses the `stateplane` database. `pnpm db:up` publishes a random local password atomically in ignored `.data/local-db-password` (mode 0600); Compose reads it through a local file mount and `pnpm db:migrate` reads the same file. Keep it while the Compose volume exists, or remove the volume and password together before a fresh bootstrap. For a disposable external database, export `DATABASE_URL` in your private process environment before `pnpm db:migrate`. If storing it in `.env.local`, load it explicitly with `set -a; . ./.env.local; set +a`; the migration command does not read env files itself. External URLs require `sslmode=verify-full` and a trusted server certificate; set `PGSSLROOTCERT` to a private CA file when needed. URL query options are limited to `sslmode` and `application_name` so they cannot override the effective host or TLS policy. `.env.local` and `.env.*.local` are ignored. Migrations run under a transaction and advisory lock and reject changed or missing applied files by SHA-256 and name. Migration 001 installs pgvector; hosted acceptance must use a pgvector-capable image. Authority tables belong to STA-5. The port and connection timeout are local bootstrap choices, not service limits or recovery promises.

## Package ownership

| Path | Responsibility |
| --- | --- |
| `packages/contracts` | Public generic IDs, capabilities and envelopes; browser-safe |
| `packages/application` | Service ports and policy boundary |
| `packages/postgres`, `migrations` | Stateplane-owned authority transaction port and future SQL |
| `packages/auth` | AuthFn-backed identity integration port; space grants remain Stateplane-owned |
| `packages/storage`, `packages/retrieval`, `packages/workers` | Originals, candidate indexes and durable projection work ports |
| `packages/api`, `packages/mcp`, `packages/cli` | Transport boundaries that must call the same services |
| `packages/read-model` | Fixed read-only DataFn resource declaration |
| `packages/testing`, `test` | Generic fixtures, package qualification and consumer checks |
| `app` | SvelteKit UI and Cloudflare HTTP entry point |

`scripts/check-boundaries.mjs` enforces the package dependency graph and keeps browser sources from importing server packages. The packed external consumer checks exports and TypeScript declarations independently of pnpm workspace links. Interfaces in scaffold packages are seam definitions; they do not implement CRUD, grant checks, source storage, search, MCP transport, or job processing. See [package qualification](docs/package-qualification.md) for version evidence and upstream dependencies.

Cloudflare's [SvelteKit Worker guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/sveltekit/) documents the adapter and generated Worker entry; its [Wrangler bundling guide](https://developers.cloudflare.com/workers/wrangler/bundling/) documents `deploy --dry-run` as a bundle inspection step. A successful dry-run does not establish deployed behavior.
