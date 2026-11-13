# Portability and erasure ledger storage (STA-69)

STA-17 makes owned spaces recoverable and portable with verifiable lifecycle outcomes. This first slice, migration `051_portability_erasure_ledger.sql`, adds only storage and its invariants: the control database's erasure ledger and lifecycle stamps, and each cell's export and import jobs, their part ledgers and the import principal map. No service writes them yet. The manifest contract and resumable export are [STA-70](portability-export.md), import and retrieval rebuild STA-71, erasure states, receipts and ledger replay STA-72, backups and restore drills STA-73, and transports STA-74.

Every database receives every migration. The erasure ledger and stamps are used in the control database; the job, part and map tables in the cell databases. In a single-database installation they share one database, so the restore guarantee below needs separate control and cell databases, as every deployed topology has ([regional topology](regional-topology.md)).

## Where the erasure ledger lives, and why

Erased data must not come back when a cell is restored from a backup or point-in-time recovery taken before the erasure. Each cell restores independently, and its backups keep earlier copies until their own retention ends ([owned spaces](owned-spaces.md#state-races-and-recovery)). A record of the erasure kept in the cell would be rolled back with the data it records. So `erasure_ledger` lives in the control database, beside `space_directory`, outside every regional cell's restorable data: restoring a cell replaces that cell's database and leaves the ledger, and the directory's tombstone and hard-erasure stamps, untouched. After a cell restore, the ledger's entries for that cell name what must be erased again; STA-72 replays them, and until then `PostgresSpaces.erasure` reports a resurrected space's database `pending`, not `erased`.

Only the control database's ledger is authoritative. Every database receives every migration, so `erasure_ledger` and its guard exist in each cell too, and the guard checks only the local `space_directory`: it cannot tell a control database from a cell. A fresh cell has no directory rows and refuses every entry (`erasure_ledger_cell`), but a cell upgraded across migration 016 keeps the directory rows 016 copied from its `spaces`, with their lifecycle and cell as of then, and accepts entries for those spaces. Such an entry sits in restorable cell data, a restore of the cell removes it, and nothing reads it. Writers (STA-72) must record entries through the control connection, never a cell's.

This guarantee covers regional restores. A restore of the control database itself is a separate procedure that STA-73 defines; it must not roll the ledger back past entries already applied to cells.

## Erasure ledger

One row per erased object, recorded before or as its cell erases it, and never changed or removed (`erasure_ledger_immutable`, `23514`, for `UPDATE`, `DELETE` and `TRUNCATE`, whatever the role):

- `scope` `space` (a whole space; `collection_id` and `source_id` null) or `source` (one source's original bytes and extracted content; both set) (`erasure_ledger_target`);
- `space_id` references `space_directory`, so a directory row with an entry is never removed;
- `cell_id` is the space's current cell when recorded (`erasure_ledger_cell`): the cell whose restore must replay the entry;
- a `space` entry needs the directory row `deleting` or `deleted`, a `source` entry a published space (`erasure_ledger_lifecycle`). The guard first updates the directory row without changing a stamped column, so a placement, lifecycle or hard-erasure change and an entry take turns: one that meets the other in flight waits, then under READ COMMITTED is checked against it, and under REPEATABLE READ or SERIALIZABLE fails with a retryable serialization error (`40001`);
- each object is recorded once (`erasure_ledger_once`, `23505`);
- `erasure_id` is an always-generated identity and `recorded_at` the database clock. IDs order entries by insertion, not commit, so replay reads every entry of a cell (index `erasure_ledger_cell`) rather than continuing past an ID.

The ledger holds identifiers and times only, never content, credentials or secrets. Later scopes need a migration that extends the check.

## Directory lifecycle stamps

`space_directory` gains three stamps that a trigger derives from the lifecycle each write publishes, whatever the writer sends, so existing directory writers are unchanged:

| Stamp | Meaning | Rule |
| --- | --- | --- |
| `archived_at` | when the space last entered `readOnly` (archive) | required while `readOnly`, kept through `suspended`, `deleting` and `deleted`, cleared on return to `active` (`space_directory_archived`) |
| `tombstoned_at` | when the directory published `deleted` | present exactly while `deleted` (`space_directory_tombstoned`); the spaces service never leaves `deleted`, and an operator repairing an inconsistent restore by hand clears the stamp with the state |
| `hard_erased_at` | when the space was recorded hard-erased | set once, to the database clock, on a tombstoned space with a `space` entry in the erasure ledger, and never changed or cleared; not on insert; the space then stays `deleted` (`space_directory_hard_erased`) |

Rows archived or deleted before migration 051 take their `updated_at`, the time of their last directory publication, which is no earlier than the state was entered. Rows `suspended` or `deleting` before 051 have no archive stamp, since the time of an earlier archive is unknown. STA-72 defines what hard erasure covers (live objects, dependent claims and chunks, original bytes) and when it is recorded.

## Export and import jobs

`portability_jobs` holds one export or import of a whole space (`kind`, job IDs `exp_` or `imp_` plus a lowercase UUID). Its binding never changes (`portability_jobs_binding`): the space owner's principal and credential, the policy version and placement generation it was admitted under, the manifest `format_version` and the consistency `watermark`.

- **Admission** share-locks the space, as record writers do, and requires the space's owner (`portability_jobs_owner`), its current policy version and placement generation (`portability_jobs_binding`), an `active` or `readOnly` space for an export and an `active` space for an import (`portability_jobs_admission`), and a queued job with nothing done (`portability_jobs_transition`). Space export and import are owner operations: a grant is per collection, and an import creates grants.
- **Watermark.** An export's watermark is a position of this cell's record event feed published for the space, or 0 while the space has none (`portability_jobs_watermark`); it is the boundary every record the export reads is as of, as an analysis job's watermark is for one collection ([analysis jobs](analysis-jobs.md)). The feed's positions are one sequence across the cell, so one position bounds every collection of the space. An import's watermark is the source export's, as its manifest states, and is not checked against this cell.
- **Manifest.** An import binds the SHA-256 digest and part count of the manifest it applies from admission. An export states both only as it completes (`portability_jobs_manifest`); the manifest's content and digest rules are [STA-70's](portability-export.md#format-version-1).
- **States** move `queued → running → completed`, to `failed` with a code, to `cancelled`, or to `expired` once the expiry has passed (completed exports expire too); nothing runs or completes after the expiry (`portability_jobs_expiry`). A running job holds a lease; its checkpoint changes only while running and its attempts only grow. Completion requires every part (`portability_jobs_parts`): for an export, the part count it states; for an import, its manifest's. An import also completes only with its owner row in the principal map (`portability_jobs_principals`). Ending a job clears its lease and stamps `finished_at`. A job row stays until its space is erased.

## Parts

`portability_parts` records each part of a job, numbered from 1 without gaps, with its `section`, rows, bytes and SHA-256 digest (`portability_parts_order`).

- An **export part** holds its content, at most 1 MiB, with its size and digest checked against it (`portability_parts_content`).
- An **import part** records a part of the source export applied to this space, with the values its manifest states, in the transaction that applies it, and holds no content; an import never records more parts than its manifest's count.

Parts are written only by their running job under an unexpired lease before the job expires (`portability_parts_job`), and never change (`portability_parts_immutable`). Each write first updates its job row without changing it, so part writes and the job's ending take turns: a completion counts exactly the parts committed before it, and no part commits after it (a writer that meets a completion in flight waits and is then refused). An export's parts are removed once it is cancelled, failed or expired; an import's record what was applied and stay (`portability_parts_kept`). Both go with space erasure.

## Principal map

`portability_principal_map` maps each principal of an import's source export to this deployment, keyed by job and source principal:

- the source **owner** maps to the importing owner, the job's own principal; one owner row per import (`portability_principal_map_owner`);
- each source **grant holder** (`agent`) maps, once issued, to a credential reissued in this space and that credential's own principal. The credential must be confirmed and unrevoked, and maps one source principal per import (`portability_principal_map_credential`). A source credential or secret is never copied; the map stores identifiers only.

Rows are written while their import is queued or running (`portability_principal_map_job`); a grant holder's target is set once, and nothing else changes (`portability_principal_map_immutable`). Each write first updates its job row without changing it, as a part write does, so mappings and the import's ending take turns: a completion sees the owner row committed before it, and no mapping commits after it. A session that meets the other in flight waits, then under READ COMMITTED is checked against it (a late mapping is refused), and under REPEATABLE READ or SERIALIZABLE fails with a retryable serialization error (`40001`), never a `portability_jobs_principals` refusal for a mapped owner. The guard share-locks the credential, so a revocation waits for the write.

## Limits

These are initial protective bounds, not measured capacity: at most 100,000 parts per job, an export part of at most 1 MiB (the authority's own record bound), a checkpoint of at most 64 KiB, a source principal ID of at most 256 characters, leases of up to 128 characters and failure codes of uppercase letters and underscores. STA-70 and STA-71 choose job budgets and expiry and record them with evidence.

## Grants, restore and upgrade

Run `pnpm db:grant-portability` after migration 052 and after every restore of a cell, through the protected cell administration connection with `STATEPLANE_CELL_ADMIN_URL` and the inventory's `STATEPLANE_CELL_ROLE`. It grants the cell operational role `SELECT, INSERT, UPDATE` on `portability_jobs` and `portability_principal_map`, `SELECT, INSERT, DELETE` on `portability_parts`, and, for the jobs Worker's export step that arrives with STA-77, `SELECT, UPDATE` on migration 052's `snapshot_step_turn` (that step's cell-wide [turn record](portability-export.md#worker), not space data) and `SELECT, UPDATE, DELETE` on `portability_removals` (the queue of ended exports still holding parts, which an owner-rights trigger fills and that step will read and clear), and reads each privilege back. Space deletion reads `portability_jobs`, `portability_parts` and `portability_principal_map` to prove erasure, so without the grant the purge commits and deletion fails with `42501`; a queue row needs no read of its own, since it goes with its export (`ON DELETE CASCADE`). No grant allows deleting a job or a mapping, or `TRUNCATE`.

Run `pnpm db:grant-control-journal` after migration 051 and after every restore of the control database, with `STATEPLANE_CONTROL_URL` and `STATEPLANE_CONTROL_ROLE`. It now also grants `SELECT, INSERT` on `erasure_ledger` and reads them back; nothing grants `UPDATE`, `DELETE` or `TRUNCATE` on it. Do not grant the ledger to a cell, settings or disposable probe role.

`stateplane_purge_space` locks the space's portability jobs right after the space, so a part or mapping write in flight finishes first and none starts after, then removes the space's mappings, parts and jobs before the rest, as migration 049's routine does; the erasure report reads all three tables. `pnpm db:restore-smoke` checks that a `pg_dump`/`pg_restore` restore keeps the job, part, map and ledger rows and recreates their guards; it does not cover migration 052's removal queues, turn record or queue trigger at this head.

**Migration 051.** The step adds three nullable columns to `space_directory` and stamps its archived and deleted rows, creates the new tables with foreign keys to `spaces`, `space_credentials` and `space_directory`, and replaces the purge routine. Under the migrator's five-second lock wait it waits for directory, space and credential writers and space purges; a busy table rolls the whole step back with `Portability and erasure ledger upgrade waits for space directory, space and credential writers and space purges; retry when long transactions finish`. It needs no drained flag: measured locally on PostgreSQL 17, the whole migrator run applying 051 took 369 to 382 ms over 10,000 directory rows and 866 to 997 ms over 100,000 (half archived or deleted), including process start and connection. Down is transactional rollback: a failed step leaves nothing behind, and a recorded step is skipped.

## Verification

`node --test test/integration/portability-storage.test.js` (part of `pnpm test:postgres`) covers applying 051 on a populated pre-051 schema (bounded wait, rollback, stamp backfill) and from empty with identical constraints, triggers, indexes, routines and privileges; restoring a separate cell database from its backup after an erasure, which resurrects the space and drops entries a cell accepted for stale pre-016-style directory rows, while the control ledger entries and stamps stay identical; every ledger, stamp, job, part and map guard; the races between a part write or an owner mapping and its job's completion; the purge and erasure report; and both grant scripts. `pnpm db:upgrade-smoke` and `pnpm db:restore-smoke` cover the upgrade path and a dump restore of migration 051's tables and guards (not migration 052's).

These are local PostgreSQL 17 results. Exact-head acceptance still needs Railway Postgres: migration 051 applied to a disposable control and cell database migrated through 050, both grant scripts against separate operational roles, and a cell restore that leaves the control ledger intact. No Cloudflare Preview, connected provider sandbox or browser path changes in this slice.
