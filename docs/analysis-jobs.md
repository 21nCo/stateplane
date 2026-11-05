# Analysis job storage (STA-57)

Migration `049_analysis_jobs.sql` adds the storage for bounded analytical work: analysis and export jobs pinned to a consistent boundary, their bounded result pages and manifests, analytical concurrency slots per space and per cell, and an as-of reconstruction index over record events by feed position. It is the first of five slices of STA-15. Bounded interactive aggregations (STA-58), the snapshot job worker with submission, status, cancellation and result retrieval (STA-59), measured projections (STA-60) and transports (STA-61) follow. Nothing in this slice aggregates, runs a job, or is reachable over HTTP, the CLI or MCP.

The [contract](../contracts/v1.md) requires complete exports and long analyses to use a pinned consistent watermark and a resumable job ID bound to authorization and placement generation, with results reauthorized at fetch. This schema stores that binding and enforces its invariants; the worker that reauthorizes each fetch is STA-59's.

## Tables

| Table | Contents | Mutability |
| --- | --- | --- |
| `analysis_jobs` | One aggregate or export job over one collection: its [binding](#binding), state, checkpoint, progress counters, budgets, lease, attempts, failure code, expiry and state times | Binding, budgets and expiry never change; state moves forward only ([states](#states)); kept until erasure |
| `analysis_result_pages` | One bounded page of a job's result: page number, row and byte offsets, row count, content (at most 1 MiB), byte size and SHA-256 digest, plus the job's binding | Immutable; removed once the job is cancelled, failed or expired, or at erasure |
| `analysis_result_manifests` | A job's complete result: page count, rows, bytes and result digest, plus the job's binding | Immutable; removed like pages |
| `analysis_space_slots` | A space's analytical concurrency slots, each free or held by one job of the space until a time | Holder only; removed at erasure |
| `analysis_cell_slots` | A cell's analytical concurrency slots, each free or held by one job of a space on that cell until a time | Holder only; cell capacity, not space data: erasure releases the slots a space's jobs hold |

`record_event_feed` gains `record_id` and `revision` and the index `record_event_feed_as_of` ([as-of reconstruction](#as-of-reconstruction)).

## Binding

Every job row binds its space and collection, the requesting principal, credential and capability (`records:read` or `export:read`), the space policy version and placement generation it was admitted under, the collection's schema version, the watermark, the canonical spec and its SHA-256 digest. Every result page and manifest row carries the space, collection, job, credential, spec digest, schema version and watermark, and a foreign key to `analysis_jobs`' `analysis_jobs_result_binding` key requires them to equal the job's (`23503` otherwise). None of these change after admission (`analysis_jobs_binding`, `23514`); nor do the budgets or expiry.

Admission (the insert) checks, under share locks of the space and collection rows (the same locks record writers take, so a lifecycle, policy, placement or schema change waits for an admission in flight and an admission that meets one waits and is then checked against it):

- the space is `active` or `readOnly` and the collection is not deleted (`analysis_jobs_admission`);
- the policy version, placement generation and schema version are the current ones (`analysis_jobs_binding`);
- the principal owns the space, or the credential's current, unexpired grant on the collection includes the capability (`analysis_jobs_grant`); this is a storage fence on top of, not instead of, request authentication and fetch-time reauthorization;
- the watermark is a position of this collection's event feed, or 0 while the collection has none (`analysis_jobs_watermark`). Events still pending publication have no position yet and fall after any watermark, so the worker publishes the collection's pending events before it pins one;
- the digest is the SHA-256 of the spec's UTF-8 bytes (`analysis_jobs_spec_digest`) and the spec is a JSON object of at most 64 KiB (`analysis_jobs_spec`);
- the job starts `queued` with nothing done (`analysis_jobs_transition`), and its expiry is after its creation time, which the database stamps (`analysis_jobs_expiry`).

## States

```
queued ──> running ──> completed ──> expired
  │          │  ↺ (lease, progress)
  │          ├──> cancelling ──> cancelled
  │          │        ↺           └──> expired
  │          ├──> failed
  │          └──> expired
  ├──> cancelled, failed or expired
```

- A running job holds a lease (`lease_id`, `leased_until`); a lease ends no later than the job expires. A reclaim after an interruption keeps the job `running`, takes a new lease and counts an attempt; attempts change only into `running`.
- Only a running job progresses: its checkpoint (`cursor_record_id`, the last record finished in key order, and `checkpoint`, a JSON object of at most 1 MiB), `records_scanned` and `runtime_ms`. Counters never decrease and stay within `budget_records` and `budget_runtime_ms` (`analysis_jobs_budget`).
- A job runs, and completes, only before `expires_at`, and expires only after it (`analysis_jobs_expiry`). A completed job expires too: `expires_at` bounds its result's lifetime.
- A job completes only with its manifest (`analysis_jobs_manifest`); fails only with a `failure_code` (`analysis_jobs_failure`); a queued job is cancelled directly, a running one through `cancelling`.
- Each state stamps its own time (`started_at`, `cancel_requested_at`, `finished_at`). Ending a job (cancelled, completed, failed or expired) clears its lease and releases its slots.
- A job row is never deleted except by erasure (`analysis_jobs_immutable`).

## Results

A page is written by its running job, under an unexpired lease and before the job expires, under a share lock of the job row, so cancelling, failing or expiring the job waits for a page in flight and a page that meets one in flight is refused (`analysis_result_pages_job`); so is a worker whose lease has lapsed. Page numbers and the primary key let only one of two workers write a given page; fencing a write to the exact lease is the worker's (STA-59), in the same transaction. Pages are numbered from 1 without gaps; each page's `row_offset` and `byte_offset` continue the previous page's (`analysis_result_pages_order`); the content is at most 1 MiB; `byte_size` is derived from it; `content_sha256` must be its digest (`analysis_result_pages_digest`); and the job's result bytes stay within `budget_bytes` (`analysis_result_pages_budget`).

The manifest states the page count, total rows, total bytes and `result_sha256`, the SHA-256 digest of the pages' `content_sha256` values (lowercase hex) concatenated in page order; all four are checked against the pages (`analysis_result_manifests_totals`). Only a manifest marks a result complete, and once it exists no page can be added (`analysis_result_pages_sealed`), so pages without a manifest are never a complete result. Pages and manifests never change (`*_immutable`) and are removed only once their job is cancelled, failed or expired, or at erasure (`*_kept`).

## Concurrency slots

Analytical work takes capacity from slots, apart from interactive reads. A job holds at most one space slot and one cell slot (`analysis_space_slots_one_per_job`, `analysis_cell_slots_one_per_job`). A slot's holder must be a job that has not ended, of the slot's space (by foreign key) or of a space on the slot's cell, held no later than the job expires (`*_holder`); a slot keeps its number (`*_key`). The guard share-locks the holder job, so a job that ends meanwhile waits and then releases the slot, and a taking that meets an ending in flight is refused. Take a job's lock before its slots. A held slot passes to another job only once its `held_until` has passed (`*_held`); its holder may extend it, never past the job's expiry. A statement that needs no job, such as an interactive aggregation, holds a free slot's row lock for its transaction instead of naming a holder.

Slot numbers run from 1 to 10, a structural upper bound of half the largest `originConnectionLimit` the topology schema accepts (5 to 20, [regional topology](regional-topology.md#provider-regions-and-budget-2026-09-28)); the jobs Worker's consumers and tick already hold up to half of a cell's origin connections, leaving the rest to the API and MCP Workers ([durable outbox](durable-outbox.md)). The rows present set the capacity in use; no slot is seeded. STA-58 inserts the slots its configured limit allows, derived from the cell's configured origin limit, and STA-60 records measured limits.

## As-of reconstruction

A record's state at a watermark is the after-image of its highest revision whose event is published at or below the watermark; a record whose first event is published later did not exist, and one whose highest such revision is a `delete` was deleted. Taking the highest revision rather than the highest position keeps the answer right even if two revisions of one record were ever published out of order (publication orders pending events by their commit clock).

Each feed row now carries its event's `record_id` and `revision`, derived from the event by trigger on every write whatever the publisher sends; a row naming another collection's event is refused (`record_event_feed_event`, `23503`). The index `record_event_feed_as_of` on `(space_id, collection_id, record_id, revision) INCLUDE (position)` serves the lookup as one backward index-only scan per record, which skips only the revisions published after the watermark and reads no event:

```sql
SELECT r.record_id, e.revision, e.operation, e.canonical_data
FROM records r
CROSS JOIN LATERAL (SELECT f.revision FROM record_event_feed f
  WHERE f.space_id = r.space_id AND f.collection_id = r.collection_id AND f.record_id = r.record_id AND f.position <= $3
  ORDER BY f.revision DESC LIMIT 1) a
JOIN record_events e ON e.space_id = r.space_id AND e.collection_id = r.collection_id AND e.record_id = r.record_id
  AND e.revision = a.revision
WHERE r.space_id = $1 AND r.collection_id = $2 AND r.record_id > $4
ORDER BY r.record_id LIMIT $5
```

Records keep their tombstones until erasure, so keyset pages over `records` see every record that ever existed.

Measured on local PostgreSQL 17 (pgvector image) with 50,000 records, 200 of them updated 2,000 times after the watermark (450,000 events), warm cache, one run each:

| Lookup | 1,000-record page with 4 hot records | Only the 200 hot records |
| --- | --- | --- |
| Before 049: `record_events` revisions descending, each probing the feed for its position | 45.7 ms, 40,567 buffer hits | 1,912 ms |
| `record_event_feed_as_of` (by revision, `INCLUDE (position)`) | 7.6 ms | 123 ms |
| An index by position instead (one descent, but wrong if revisions were published out of order) | 9.2 ms | not measured |

Before this index the cost of a record grew with the writes after the watermark at about 9.5 ms per 2,000 later revisions; with it, about 0.36 ms. Deriving the two columns on publication added about 16 microseconds per published event (10,000 events in 50-row publications: 285 ms with the trigger and index, 127 ms without the trigger), about 1.6 ms for a full 101-event publication. These are local observations, not Railway or Hyperdrive latency claims; STA-60 measures the target.

## Limits

These are initial protective bounds, not measured capacity: a spec of at most 64 KiB, a checkpoint of at most 1 MiB and a page of at most 1 MiB (the authority's own record bound), job IDs `anj_` plus 36 lowercase hexadecimal and hyphen characters, failure codes of uppercase letters and underscores, leases of up to 128 characters, and at most 10 slots of each kind. Budgets and expiry are per job; STA-58 and STA-59 choose their values, and STA-61 records them with evidence.

## Migration 049

The step takes `record_event_feed` exclusively first, then share-row-exclusive locks on `collections`, `collection_versions` and `spaces`, under the migrator's five-second lock wait. A space purge deletes record events, and so feed rows, before it deletes collections and updates its space, so taking the feed first never waits while holding a lock that purge needs: a purge already past its events finishes with its existing routine (no analysis rows exist yet) and the step then applies. While the step runs, event publishers and readers, space purges and collection, schema version and space updates wait; record writers do not. A busy feed or a deadlock rolls the whole step back with a retry message.

The step backfills every feed row's record and revision. Measured locally, it held its locks for 132 to 155 ms with 10,000 feed rows, 679 to 918 ms with 50,000 and 10.2 to 12.0 s with 500,000. The migrator takes the step's locks in its own order and, above 50,000 feed rows, refuses unless `STATEPLANE_POPULATED_INDEX_UPGRADE=drained` is set after stopping event readers and space purges, so an undrained upgrade holds them for under about a second.

Down is transactional rollback: a failed or refused step leaves no analysis table, feed column, trigger or routine change behind, and a recorded step is skipped.

## Erasure, grants, restore and upgrade

`stateplane_purge_space` now locks the space's jobs first (so a page, manifest or slot write in flight finishes first and none starts after), releases the cell slots they hold, and removes the space's slots, pages, manifests and jobs before anything else. The space erasure report (`PostgresSpaces.erasure`) reads every analysis table, and the cell slots by holder, before it reports the database erased.

Run `pnpm db:grant-analysis` after migration 049 and after every restore, through the protected cell administration connection with `STATEPLANE_CELL_ADMIN_URL` and the inventory's `STATEPLANE_CELL_ROLE`. It grants the cell operational role `SELECT, INSERT, UPDATE` on `analysis_jobs`, `analysis_space_slots` and `analysis_cell_slots` and `SELECT, INSERT, DELETE` on `analysis_result_pages` and `analysis_result_manifests`, and reads each privilege back. Space deletion reads these tables to prove erasure, so without the grant the purge commits and deletion fails with `42501`. No grant allows deleting a job or a slot, or `TRUNCATE`; ending a job releases its slots through an owner-rights trigger. The checked digests use built-in routines, so no routine grant is needed.

`pnpm db:restore-smoke` seeds every analysis table (a completed export with a page and manifest, a running job holding a space slot and a cell slot), compares them across the dump and restore, proves the restored guards and as-of index, and has the restored operational role read each table for erasure and end the running job, which releases its slots. `pnpm db:upgrade-smoke` applies 049 to the 2,000-event upgrade fixture, checks every feed row's backfilled record and revision, plans the as-of lookup and the erasure lookups by index, and compares the upgraded schema with a fresh install. `test/integration/analysis-storage.test.js` (in `pnpm test:postgres`) covers admission and binding, transitions, results, slots, a cancel racing a page write under `READ COMMITTED` and `REPEATABLE READ`, as-of reconstruction and its plan, erasure through a nonowner role, and a real upgrade that rolls back whole when the feed is busy or above its bound and completes a purge already in flight.

These are local PostgreSQL checks. Railway Postgres acceptance of the migration, the grant script, the restore and the purge through the operational role remains external evidence.
