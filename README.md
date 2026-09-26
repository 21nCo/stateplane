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
pnpm test:e2e
```

`pnpm check` runs lint and boundary checks, typecheck, the STA-2 contract fixture suite, focused published package tests, builds, isolated packed-package consumer, and Worker dry-run. `pnpm worker:package-dry-run` separately probes production package bundling into a Worker; the Node-only McpFn testing package is excluded. Playwright needs Chromium (`pnpm exec playwright install chromium`) before `pnpm test:e2e` on a new machine. CI installs it with system dependencies. Use `pnpm db:down` after local testing. Run `docker compose down -v` only when intentionally deleting this checkout's disposable data.

Local Worker/R2 development: `pnpm dev:worker`. Wrangler persists its local emulated R2 state in `.data/wrangler/app`. The local binding is `ORIGINALS` and its bucket name is `stateplane-originals-local`; no Cloudflare account or shared R2 resource is used by `wrangler dev`. `pnpm --filter @stateplane/app dev` runs Vite without Worker bindings for UI work. A remote Cloudflare Preview, Hyperdrive, and a real regional R2 bucket are later acceptance boundaries, not results of local development.

The isolated Postgres service binds only `127.0.0.1:55432`, uses the `stateplane` database and a disposable local password. `DATABASE_URL` may override it for a disposable external database; keep that value in your private process environment or an ignored `.env.*.local` file. Migrations run under a transaction and advisory lock and reject changed files by SHA-256. Migration 001 installs pgvector; authority tables belong to STA-5. The port and connection timeout are local bootstrap choices, not service limits or recovery promises.

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
