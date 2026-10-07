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

The app mounts `/v1/*` through a deliberately opt-in nonproduction host. For
local or isolated Preview smoke, set `STATEPLANE_ENV=local` or `preview`,
`STATEPLANE_TEST_HTTP=1`, a private 32-character or longer
`STATEPLANE_TEST_TOKEN`, `STATEPLANE_TEST_OWNER`,
`STATEPLANE_TEST_CREDENTIAL`, and a private hex-encoded 32-byte
`STATEPLANE_TEST_CURSOR_SECRET`. Supply either
`STATEPLANE_TEST_DATABASE_URL` for local PostgreSQL or the `AUTHORITY`
Hyperdrive binding for Preview. The optional cell and storage target IDs
default to `cell-a` and `target-a`. This fixture host uses one configured
bearer and does not establish connected AuthFn provider acceptance. Without
all opt-in bindings, `/v1/*` fails closed with a structured 503. Keep these
secrets outside tracked configuration and never use the fixture host for a
shared or production environment.

Every selected-space call takes a fresh provider credential and placement
snapshot. Collection effects additionally check live policy, grant and
placement in their database transaction. Space administration uses
`PostgresSpaces` owner checks. A wrong-space selector can return `NOT_FOUND`.
Errors have `contractVersion`, stable `error.code`, `message`, `retryable` and
`requestId`, without provider messages or credential values. A write with an
unacknowledged commit reports `COMMIT_OUTCOME_UNKNOWN`; its result is unknown.
CLI errors use the same fields on stderr; locally detected failures have a null
request ID. Both clients percent-encode each path selector as one component,
including `/` and `\\`. URL parsers remove dot-only path segments, so a selector
whose entire value is `.` or `..` is sent as `;.` or `;..` respectively. A literal
leading semicolon is encoded as `%3B`, keeping it distinct from that marker.

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
stateplane spaces create --space sp_123e4567-e89b-42d3-a456-426614174000
stateplane spaces select --space sp_123e4567-e89b-42d3-a456-426614174000
stateplane collections list
stateplane records create --collection entries --key ' item-1 ' \
  --data '{"label":"Item 1","state":"open"}' --idempotency-key req-a \
  --expected-schema-version 1
```

`keychain` is the default. On macOS, it uses Keychain; on Linux, it uses Secret
Service through `secret-tool`. If OS storage is unavailable, explicitly select `--store file`.
An absent stored item returns `UNAUTHENTICATED`; an unavailable OS store returns
`KEYCHAIN_UNAVAILABLE`. Neither error prints backend diagnostics or a token.
The macOS path requires the system `swift` command (install Apple Command Line
Tools with `xcode-select --install` if it is absent). It sends the token to a
small bundled Keychain helper over stdin, then reads the item back before
reporting `configured:true`; the token never appears in a process argument.
The helper applies a Keychain access list restricted to the calling application,
including when replacing an older item. It supports CLI use after the login
Keychain is unlocked without a per-command user-presence prompt.
`auth login` validates the bearer with `GET /v1/auth/session` before saving it.
For offline bootstrap, `auth import --token-stdin --store file` stores a
credential without validation; the next API call checks it. Invalid tokens
and provider failures produce structured errors without echoing the input.
That stores the token in a mode-0600 file in the mode-0700 Stateplane config
directory on Unix. On Windows, the CLI uses the bundled PowerShell helper to
remove inherited file ACLs and grant access only to the current user, SYSTEM
and Administrators. It verifies the ACL when reading a stored token or config;
if ACL enforcement is unavailable, configuration fails closed with
`INSECURE_CONFIGURATION`. Windows users must select `--store file` or supply
`STATEPLANE_TOKEN`, because the Keychain and Secret Service adapters are not
available there. A process-only alternative is `STATEPLANE_TOKEN`; it overrides the
stored credential and is never written to the config. Avoid putting secrets
in command arguments. `stateplane config show` exports only endpoint, selected
space and storage kind. `stateplane auth logout` removes every stored
credential. Changing the configured endpoint clears the selected space and
stored credential; select a space for the new endpoint before issuing a
space-scoped command. Setting the same endpoint again retains the selection.
During a store switch, private config tracks both locations until the old
credential is removed. Logout and endpoint changes clean both locations after
an interrupted switch; repeat either command after a temporary store failure.
Config and secret changes are serialized across CLI processes by a private
SQLite transaction lock. A command that cannot acquire it within 120 seconds
returns `CONFIGURATION_BUSY` without changing credentials; repeat it after the
other command finishes. The 120-second bound matches the maximum configured
HTTP timeout. The OS releases the transaction if a process exits unexpectedly.
Each HTTP command captures the endpoint, selected space, storage kind and
credential under that same lock before sending a request.
Version, revision, limit, and timeout arguments use positive decimal digits
without signs, leading zeros, spaces, hexadecimal, or exponent notation.

Every `spaces create` request supplies a caller-generated `sp_<UUID>` ID.
Retain it before sending the request. If the response is lost, repeat the
same create request and cell selection or use `spaces get --space <ID>`;
an explicit same-ID create retry locks and inspects pending provisioning,
then publishes a verified committed cell or completes an absent cell. A live
creator holding the reservation lock finishes first. If lease-expiry recovery
has already retired an absent cell, the retry returns `UNIQUE_CONFLICT` and
the client must choose a new ID; the retired ID is never reused. If recovery
cannot verify the cell, the retry fails closed and may be repeated after the
cell is available. For schema define/revise
and lifecycle changes, `COMMIT_OUTCOME_UNKNOWN` means read back the selected
space or collection before deciding whether another change is needed.
Unknown or misplaced CLI flags are rejected before a saved space can be used
for an effect. `--expected-schema-version` is available on create, replace,
patch and delete; use it to reject a write after an incompatible schema
revision. The CLI accepts `--json` for scripts and always emits JSON. It does
not accept `--verbose` or `--debug`, so those flags cannot expose credentials.
Explicitly empty space, cell, sort, and external-key selectors are rejected.
Use `--name=--literal-value` when an identifier starts with `--`; the equals
form distinguishes that value from another option name.
Commands that accept a JSON payload require exactly one of `--data` and
`--file`; supplying both is an error even if one value is empty.

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
CLI preserves each valid line's exact JSON text in the manifest. Keep the
original file bytes for same-key recovery; reformatting an item changes batch
identity even when its parsed JSON value is equivalent. The
manifest is limited to 20 items and 2 MiB of serialized item bytes by the
authority. The HTTP JSON string-array envelope must also fit 3 MiB after
escaping; the CLI checks both byte budgets before sending. Permanent item
count and item-byte violations return nonretryable `INVALID_ARGUMENT`;
an oversized HTTP envelope returns nonretryable `RATE_LIMITED`. Retry the
unchanged file and operation key to resume pending
items; use `--retry-failed` only when intentionally retrying failed items.
After a timeout or `OUTCOME_UNKNOWN`, first read batch status. A standalone
write is never retried automatically. Resubmit the **identical** record body
with the **same idempotency key** to recover its receipt. `Retry-After` controls
bounded automatic retries for GET and read-only query/count POST requests.
Writes are never retried automatically. Query `nextCursor` is opaque
and bound to the same credential, space, collection and query; live pages are
not a fixed export snapshot.

The API applies the authority's existing 30-second transaction budget,
32 KiB query envelope, 1 MiB record/schema body and 3 MiB batch envelope.
Those are protective implementation limits from STA-8, not measured remote
throughput. The CLI checks the complete serialized HTTP body against each
endpoint's limit before sending; oversized local input returns a nonretryable
`RATE_LIMITED` error. HTTP rejects a body beyond the same limit with
`RATE_LIMITED`, `retryable: false`, and no `Retry-After` header, including
requests without `Content-Length`. A service time or capacity limit can also
return `RATE_LIMITED`; that response remains retryable and carries
`Retry-After`. An explicitly empty query or event cursor is invalid;
omit `--cursor` to request the first page. The CLI timeout defaults to 30 seconds and can be set with
`--timeout` in milliseconds up to 120 seconds. Keep the CLI timeout above the
server budget when possible; a client timeout on a write is still ambiguous.
The event feed returns at most 100 immutable metadata entries per page and
uses migration 037's commit-safe feed position index. A trigger writes pending
markers in the record writer transaction; polling publishes at most 101
committed markers without scanning retained event history. Grant the separate
cell runtime role the feed, pending table and sequence privileges after each
migration or restore as described in [owned spaces](owned-spaces.md). On an existing database
with events, the migrator refuses pending 036 or 037 unless record writers are
stopped and `STATEPLANE_POPULATED_INDEX_UPGRADE=drained` is set. Its preflight
takes writer-excluding record and event locks without waiting behind active
writers, then holds them through migration commit. The flag does not drain
traffic itself. Keep writers stopped until commit, verify the migration ledger
and feed row count, and measure the index build lock and feed plans on
disposable Railway before increasing the page limit. Event cursors
are page positions, not export snapshots. The event `nextCursor` is the last
observed event even on a short page; an empty poll retains the input cursor.

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
