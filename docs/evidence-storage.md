# Evidence storage schema (STA-13 slice 1)

Migration `040_evidence_storage.sql` adds the Postgres tables for sources, original objects, upload grants and attempts, extraction versions, claims and typed links. It is storage only. No service, HTTP, CLI or MCP operation reads or writes these tables yet; slices STA-33 to STA-37 add them. The [v1 contract](../contracts/v1.md) §3 and §6 stay normative.

## Ownership and scope

Every row carries `space_id` and its owning `collection_id`, and every foreign-key path ends at `collections(space_id, collection_id)`. Sources and claims keep their canonical identity, revision and tombstone in the existing `entity_refs` table (migration 002). `sources` and `claims` hold their payload, with a kind-checked foreign key to that identity. A deferred constraint trigger on `entity_refs` makes sure that, at commit, each source identity has its source row and each live claim's current revision exists. Claim evidence may cite a source in another collection of the same space. A link endpoint must be in the link's space, and its owner must be one of its two endpoint collections. Citing or linking grants no access: service slices must authorize every endpoint and cited source against the caller's own collection grants.

| Table | Contents | Mutability |
| --- | --- | --- |
| `sources` | Locator (never proof of fetched bytes) and creating actor | Lifecycle via `entity_refs` |
| `original_objects` | One per source: `sha256`, `byte_size`, `mime_type`, `captured_at`, `observed_at`, `reference_only` | Immutable |
| `source_upload_grants` | Actor, collection, MIME, `max_bytes`, optional expected digest, expiry, then either revocation or finalization | Mutable state |
| `source_upload_attempts` | Staging blob key, observed digest, size and MIME, state, failure code, staging removal | Mutable state |
| `extraction_versions` | Parser, parser version, content, source offsets, cited original digest | Immutable |
| `claims` | Creating actor | Lifecycle via `entity_refs` |
| `claim_revisions` | Statement, attribution, observed and valid times, review status and reviewer | Immutable |
| `claim_evidence` | Cited source, optional extraction version and content range per revision | Immutable |
| `links` | Type, `restrict`/`detach` policy, typed `record`/`source`/`claim` endpoints | Tombstone only |

A source always has its original: `sources_original` is a deferred foreign key, so both rows commit together. A reference-only original has no digest or size, which discloses that no bytes were fetched. A stored original needs a digest, size and lowercase MIME type essence. The blob store addresses bytes by space and digest in the space's storage target, so that pair is the original pointer. An extraction version cites the exact original digest it parsed, so a reference-only source cannot have one. Versions and claim revisions start at 1 and have no gaps. A corrected extraction is the next version; earlier versions stay readable. Review produces a new claim revision. `accepted` and `rejected` require a reviewer and review time, and `unreviewed` is the default.

## Immutability and erasure

Triggers reject UPDATE, DELETE and TRUNCATE on `original_objects`, `extraction_versions`, `claim_revisions` and `claim_evidence`, and DELETE and TRUNCATE on `links`. A link may change only from live to tombstoned, with the next revision and a tombstone time; its endpoints, type, policy and owner never change, and it is never resurrected. As with record events, one exception exists: the table owner may delete rows while running the `stateplane_purge_space` SECURITY DEFINER routine for that one `deleting` space. Setting `stateplane.erasing_space` as a non-owner role does not bypass the guard. The purge routine removes evidence rows before the records and identities they cite, and `PostgresSpaces` reports a space erased only when no evidence row remains. Original bytes and staging blobs live outside the database, so removing them is a separate retention step (STA-36). Removing the metadata alone is not proof that bytes or backups are gone.

## Links and endpoint deletion

The database enforces the contract's "no live dangling link" rule. Tombstoning a record or `entity_refs` row while a live `restrict` link touches it fails with SQLSTATE `23001` (`restrict_violation`, constraint `links_restrict`); the service maps this to `LINK_RESTRICTED`. Mixed policies fail the same way. While only live `detach` links remain, the deletion fails with `23503`, constraint `links_detach`. The writer must tombstone those links, with their events and outbox entries, in the same transaction before the endpoint. Creating a link to a tombstoned endpoint fails with `23503`, constraint `links_live_endpoint`.

A new link share-locks both live endpoint rows. The update that tombstones an endpoint conflicts with that lock, so under READ COMMITTED, the authority's isolation level, whichever transaction runs second waits and sees the other's commit. Under SERIALIZABLE, conflict detection covers the same race. A REPEATABLE READ snapshot could miss a link committed after it began, so tombstoning an endpoint at that level fails with `0A000`. Link creation therefore also serializes with ordinary updates to its endpoint rows for the duration of the transaction. The guard functions run with owner rights, so operational roles can keep deleting records without link privileges.

## Bounds

These are initial integrity backstops, not measured provider limits. Extraction content, its offsets JSON and claim statements are each capped at 1,048,576 UTF-8 bytes, the same bound as canonical record data. Locators are capped at 4,096 bytes, attribution at 1,024, parser names, versions and link types at 256, staging keys at 1,024 and failure codes at 64. MIME types follow the RFC 6838 essence form with at most 127 characters per part. Upload size limits, supported MIME types, offset units and grant lifetimes belong to STA-33 and STA-34, and must be recorded there with evidence.

## Upgrade, restore and grants

Migration 040 creates empty tables and adds triggers to `records` and `entity_refs`. It scans no existing rows, so a populated upgrade needs no drained-traffic flag. It does take `SHARE ROW EXCLUSIVE` locks on `collections`, `records` and `entity_refs` until the migration commits. The migrator bounds that wait to five seconds. A busy record writer makes it fail and roll back without any 040 objects, and it is safe to retry. Like the rest of the migration history, 040 is forward-only: "down" means that rollback, not a reverse script. Triggers and foreign keys are post-data objects, so `pg_restore` loads rows first and then recreates the guards. The restore smoke checks that a restored original still rejects updates and that a restored `restrict` link still blocks deleting its record. Operational table grants for these tables arrive with the service slices that use them; this slice adds none.

## Verification

`node --test test/integration/evidence-storage.test.js` (part of `pnpm test:postgres`) covers immutability, extraction versions, original and claim checks, ownership and space keys, link updates, restrict and detach for every endpoint kind, the link and deletion race in both orders, the REPEATABLE READ refusal, upload ledger rules, scoped erasure, and 040's atomic rollback and retry on a populated 039 database. `pnpm db:restore-smoke` and `pnpm db:upgrade-smoke` include the new tables. These are local Postgres checks; Railway Postgres acceptance is recorded separately.
