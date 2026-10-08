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
unacknowledged commit reports `COMMIT_OUTCOME_UNKNOWN`; writes retain an unknown
result and require readback. GET and exact query/count operations can retry that
response with `Retry-After` because repeating those reads is safe.
The opt-in local/Preview HTTP host limits PostgreSQL connection acquisition and
pool queue wait to five seconds. The default PostgreSQL statement limit is five
seconds; transaction code can narrow or extend that server limit within its
own request budget. A silent established query is retired after seven seconds,
giving the default server cancellation time to arrive first. The complete HTTP request has a
12-second fallback deadline. A safe read or failed connection acquisition
returns redacted `PROVIDER_UNAVAILABLE` with HTTP 503 and `Retry-After: 1`.
A write may have committed before its response was lost, so an uncertain
in-flight timeout returns `COMMIT_OUTCOME_UNKNOWN` with `retryable: false` and
no `Retry-After`.
PostgreSQL's cancellation before COMMIT returns `RATE_LIMITED` after rollback.
A cancellation reported for a sent COMMIT remains `COMMIT_OUTCOME_UNKNOWN`, as
does a space creation after a separate cell commit when directory publication
fails. Recover with the original credential and operation identity before any
new write.
Timed-out sockets are discarded, and later requests can acquire new connections
after recovery. The CLI automatically retries only safe reads. For a write whose
outcome is uncertain, use the original credential, canonical request and
idempotency key for explicit receipt
recovery. Do not submit a changed request or automatically repeat writes.
CLI errors use the same fields on stderr; locally detected failures have a null
request ID. Both clients percent-encode each path selector as one component,
including `/` and `\\`. URL parsers remove dot-only path segments, so a selector
whose entire value is `.` or `..` is sent as `;.` or `;..` respectively. A literal
leading semicolon is encoded as `%3B`, keeping it distinct from that marker.

## Install the CLI on a clean machine

Use Node 22.13+ and a tarball built from this checkout:

```sh
pnpm --filter @stateplane/contracts build
pnpm --filter @stateplane/cli build
cd packages/cli
pnpm pack --pack-destination /tmp
npm install --global /tmp/stateplane-cli-0.1.0.tgz
stateplane help
```

The CLI build bundles its shared route helpers from `@stateplane/contracts`
into the tarball; installation needs only the CLI tarball. The package has no
workspace runtime dependencies. `stateplane` emits one JSON
value to stdout on success. On failure it emits one JSON error to stderr and
exits nonzero. It never prints a bearer token, request body or provider error.
`--json` is accepted for scripts; JSON is always the output format.

Configure an HTTPS endpoint. Plain HTTP is accepted only for loopback
development. Supply a bearer session token or API key through stdin:

```sh
stateplane config endpoint --url https://stateplane.example.invalid/
stateplane auth login --token-stdin --store file < /private/path/token
stateplane spaces list
stateplane spaces list --cursor '<nextCursor>'
stateplane spaces create --space sp_123e4567-e89b-42d3-a456-426614174000
stateplane spaces select --space sp_123e4567-e89b-42d3-a456-426614174000
stateplane collections list
stateplane collections list --cursor '<nextCursor>'
stateplane records create --collection entries --key ' item-1 ' \
  --data '{"label":"Item 1","state":"open"}' --idempotency-key req-a \
  --expected-schema-version 1
```

For `records create`, an external key is normalized to NFC and trimmed using
the fixed v1 Unicode whitespace set listed in OpenAPI. The resulting key must
be nonempty and at most 256 UTF-8 bytes. OpenAPI publishes the byte budget as
`x-utf8MaxBytes`; generated clients should enforce it after normalization and
trim. The API returns `INVALID_ARGUMENT` for a rejected key and writes no
record, event or receipt. An idempotency key must be a nonempty Unicode-scalar
string of at most 256 UTF-8 bytes; generated clients should enforce its
`x-utf8MaxBytes` extension. Replaying an accepted
create with the same idempotency key and equivalent normalized external key
returns the original receipt only when the rest of the canonical request
fingerprint also matches. Changed data or expected schema version returns
`IDEMPOTENCY_MISMATCH` without a new record, event or receipt. After an unknown
commit, use the original credential and retry the identical canonical request
with its original idempotency key to recover that credential's receipt. A new
credential cannot recover the old receipt and may submit a separate write.

On Linux, `keychain` is the default and uses Secret Service through
`secret-tool`. On macOS and Windows, the default is the protected file store.
The macOS legacy login Keychain path is disabled for new writes and reads: a
native probe observed that an unrelated same-account Swift process could read
a disposable token with interaction disabled. Selecting `--store keychain` on
macOS fails with `KEYCHAIN_UNAVAILABLE` before saving a token. Existing
Keychain items can still be removed by `auth logout` or an endpoint change.
Use `--store file` explicitly for unattended jobs or supply `STATEPLANE_TOKEN`
only in the process environment. On Linux, select `--store file` if Secret
Service is unavailable.
An absent stored item returns `UNAUTHENTICATED`; an unavailable OS store returns
`KEYCHAIN_UNAVAILABLE`. Neither error prints backend diagnostics or a token.
Removing a legacy macOS Keychain item requires `xcrun` and its selected Swift
toolchain. If that cleanup fails, the credential-location journal stays in
place for a later logout or endpoint change. A locked or headless Keychain can
yield `KEYCHAIN_UNAVAILABLE`.
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
`spaces list` returns `{items,cursor}` with at most eight spaces per page. Pass the
opaque cursor to the next call until it is `null`. Each page rechecks the
current session and owner. Pending provisioning can produce a short or empty
page with a non-null cursor; continue rather than treating that page as the end.
Cursors are bound to the owner and credential, expire after 15 minutes, and
traverse live directory state rather than a snapshot. An invalid, expired or
cross-credential cursor returns `CURSOR_INVALID`; restart from the first page.
Receiving instances allow up to 60 seconds of issuing-node clock lead. The
15-minute age check still uses the signed issue time; node clocks need
synchronization within this allowance. This is a protective operational choice,
not a measured Cloudflare clock-skew guarantee.
The eight-item cap matches collection discovery and limits a request to nine
ordered directory candidates and at most eight provisioning recovery attempts.
All HTTP instances serving one control directory must use the same private
cursor secret; an instance without that configured secret refuses space pages.
Rotating it invalidates outstanding cursors. Direct `PostgresSpaces.list()`
returns an async iterator of spaces. Consume it with `for await`; it scans one
bounded page at a time, including pages containing only pending reservations,
and rechecks the session on every page. Its internal continuation does not use
the 15-minute HTTP cursor lifetime. An iterator is a live traversal, not a
snapshot; callers that collect all items still own the resulting memory cost.
The local PostgreSQL page test uses 55 active spaces and one pending
reservation to verify a short first page, continuation and a changed owner
before its later page. These are local
bounds, not a regional latency target.

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

Query and count take the same typed `--predicates` JSON array. Each predicate
has `field`, `kind`, and `operator`; every non-null kind also requires `value`.
`null` uses only `isNull` and has no value. `string`, `number`, `boolean`, and
`date-time` use `eq`, `lt`, `lte`, `gt`, or `gte` with one value of that kind,
or `in` with 1–16 values of that kind. Date-time values are valid UTC `Z`
instants; the authority checks the calendar and known leap-second dates.
String and date-time values must fit 512 UTF-8 bytes, including multibyte
characters. Malformed predicates return `INVALID_ARGUMENT` before the record
query. Undeclared, non-filterable, or unready fields return `SCHEMA_CONFLICT`
after the filter index lookup. HTTP and CLI report the same error code.

An ingestion file or `--file -` stream is NDJSON with one record request per
line, omitting `idempotencyKey`; the authority derives stable item keys. The
CLI preserves each valid line's exact JSON text in the manifest. Keep the
original file bytes for same-key recovery; reformatting an item changes batch
identity even when its parsed JSON value is equivalent. The
manifest is limited to 20 items and 2 MiB of serialized item bytes by the
authority. The HTTP JSON string-array envelope must also fit 3 MiB after
escaping; the CLI checks both byte budgets before sending. Permanent item
count, item-byte and aggregate-byte violations return nonretryable `INVALID_ARGUMENT`;
an oversized HTTP envelope returns nonretryable `RATE_LIMITED`. Correct fixed
limit violations before submitting again. After an interrupted or uncertain
ingest, use the original credential to read batch status, then retry the
unchanged file and operation key to resume pending items;
use `--retry-failed` only when intentionally retrying failed items.
For a batch timeout or `OUTCOME_UNKNOWN`, read batch status with the original
credential, space, collection and operation key before resubmitting the
unchanged manifest. A standalone write is never retried automatically. Use
the original credential to resubmit the **identical canonical request** with
the **same idempotency key** to recover its receipt. A changed request returns
`IDEMPOTENCY_MISMATCH`; changing credentials does not recover the original
receipt and may create a separate effect. `Retry-After` controls
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
`--timeout` in milliseconds up to 120 seconds. Collection discovery returns
`{items,cursor}` with at most eight canonical definitions per page. Pass its
non-null cursor to the next `collections list --cursor` call. An empty or
malformed supplied cursor returns `CURSOR_INVALID`; omitting `--cursor`
requests the first page. Each page checks current space and
collection grants, so a revoked collection cannot appear on a later page.
Read, write and schema grants each permit definition discovery; a write-only
grant does not permit reading records.
The eight-definition cap bounds a page to roughly eight 1 MiB definitions,
plus metadata, and is a protective limit rather than measured Worker capacity.
Keep the CLI timeout above the
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
