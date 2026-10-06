# HTTP and CLI v1

`@stateplane/api` exports `createHttpHandler({ services, identity })`. The
handler accepts standard `Request` objects and returns standard `Response`
objects. `postgresServices(spaces, cells, receiptRetentionSeconds)` in
`@stateplane/postgres` composes the existing `PostgresSpaces`,
`CollectionRegistry`, and `PostgresAuthority` implementations. Supply the
same private, at least 32-byte cursor secret to every process serving one
cell. The HTTP host owns the AuthFn config, control/cell database bindings,
and `IdentityVerifier`; it must not expose a direct database endpoint to CLI
clients. The OpenAPI surface is [openapi.yaml](../contracts/openapi.yaml).

Every selected-space call takes a fresh provider credential and placement
snapshot. Collection effects additionally check live policy, grant and
placement in their database transaction. Space administration uses
`PostgresSpaces` owner checks. A wrong-space selector can return `NOT_FOUND`.
Errors have `contractVersion`, stable `error.code`, `message`, `retryable` and
`requestId`, without provider messages or credential values. A write with an
unacknowledged commit reports `COMMIT_OUTCOME_UNKNOWN`; its result is unknown.

## Install the CLI on a clean machine

Use Node 22.13+ and a tarball built from this checkout:

```sh
pnpm --filter @stateplane/cli build
cd packages/cli
pnpm pack --pack-destination /tmp
npm install --global /tmp/stateplane-cli-0.1.0.tgz
stateplane help
```

The package has no workspace runtime dependencies. `stateplane` emits one JSON
value to stdout on success. On failure it emits one JSON error to stderr and
exits nonzero. It never prints a bearer token, request body or provider error.
`--json` is accepted for scripts; JSON is always the output format.

Configure an HTTPS endpoint. Plain HTTP is accepted only for loopback
development. Supply a bearer session token or API key through stdin:

```sh
stateplane config endpoint --url https://stateplane.example.invalid/
stateplane auth login --token-stdin --store keychain < /private/path/token
stateplane spaces list
stateplane spaces select --space sp_alpha
stateplane collections list
stateplane records create --collection entries --key ' item-1 ' \
  --data '{"label":"Item 1","state":"open"}' --idempotency-key req-a
```

`keychain` is the default. On macOS, it uses Keychain; on Linux, it uses Secret
Service through `secret-tool`. If OS storage is unavailable, explicitly select `--store file`.
That stores the token in a mode-0600 file in the mode-0700 Stateplane config
directory. A process-only alternative is `STATEPLANE_TOKEN`; it overrides the
stored credential and is never written to the config. Avoid putting secrets
in command arguments. `stateplane config show` exports only endpoint, selected
space and storage kind. `stateplane auth logout` removes the selected stored
credential.

## Queries, ingestion and recovery

```sh
stateplane records query --collection entries --limit 25 --predicates '[]'
stateplane records query --collection entries --limit 25 --predicates '[]' --cursor '<nextCursor>'
stateplane records count --collection entries --predicates '[]'
stateplane batches ingest --collection entries --operation-key import-1 --file ./items.ndjson
stateplane batches status --collection entries --operation-key import-1
```

An ingestion file or `--file -` stream is NDJSON with one record request per
line, omitting `idempotencyKey`; the authority derives stable item keys. The
manifest is limited to 20 items and 2 MiB of serialized item bytes by the
authority. Retry the unchanged file and operation key to resume pending
items; use `--retry-failed` only when intentionally retrying failed items.
After a timeout or `OUTCOME_UNKNOWN`, first read batch status. A standalone
write is never retried automatically. Resubmit the **identical** record body
with the **same idempotency key** to recover its receipt. `Retry-After` controls
bounded automatic retries for GET requests only. Query `nextCursor` is opaque
and bound to the same credential, space, collection and query; live pages are
not a fixed export snapshot.

The API applies the authority's existing 30-second transaction budget,
32 KiB query envelope, 1 MiB record/schema body and 3 MiB batch envelope.
Those are protective implementation limits from STA-8, not measured remote
throughput. The CLI timeout defaults to 30 seconds and can be set with
`--timeout` in milliseconds up to 120 seconds. Keep the CLI timeout above the
server budget when possible; a client timeout on a write is still ambiguous.
The event feed returns at most 100 immutable metadata entries per page and
uses migration 036's scoped cursor index. Apply that migration with record
writers drained on a populated database; measure the index build lock and
feed plans on disposable Railway before increasing the limit. Event cursors
are page positions, not export snapshots.

## Acceptance boundaries

The local contract fixture proves HTTP and packaged CLI parity, authorization
on each selected-space call, structured error redaction, and safe retry rules.
It does not prove connected AuthFn provider behavior or Cloudflare routing.
At exact-head external acceptance, use a disposable Railway PostgreSQL
database to run migrations and HTTP read/write/replay checks, then a Cloudflare
Preview with Hyperdrive for actual Worker behavior, then an authenticated
Aside Browser journey. Verify cleanup of every disposable resource. A
connected provider sandbox is needed for invalid/revoked credential and
provider-failure redaction checks. Carry unrun boundaries to the final
regional acceptance issue STA-21 rather than reporting them as passed.
