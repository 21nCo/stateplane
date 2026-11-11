# Analysis measurements, freshness and reconciliation (STA-60)

The fourth of five slices of STA-15, after [analysis job storage](analysis-jobs.md) (STA-57), [interactive aggregations](analysis-aggregations.md) (STA-58) and [snapshot jobs](analysis-jobs.md#jobs-sta-59) (STA-59). It backs the expensive analytical access patterns with evidence and labels every result exact or stale:

- `scripts/analysis-measure.mjs` (`pnpm analysis:measure`) measures aggregations, their plans, a candidate typed index, snapshot jobs, reconciliation and mixed interactive and analytical load on a named generic fixture. Its local report is [`docs/measurements/analysis-measurements-local.json`](measurements/analysis-measurements-local.json).
- The measurements decide what is added: [no typed index, projection table or partition](#typed-indexes-and-projections) is justified by them; the [limits](#limits) are recorded with their evidence, and [off-ramp criteria](#off-ramp-to-a-dedicated-analytical-store) say when a projection or a dedicated analytical store becomes justified.
- Every aggregation and snapshot job result states its [freshness](#freshness): `exact`, or `stale` once the collection was written after the job's watermark.
- `reconcileIndexes` (`pnpm db:reconcile-indexes`) [reconciles](#reconciliation) the typed index projection that every exact query, count and interactive aggregation reads against what each record's canonical data derives, and reports drift.

No HTTP, CLI or MCP surface reaches aggregations or jobs yet (STA-61).

## Fixture and method

`analysis-fixture/v1` is generic: each record holds `team` (a string, 20 values), `score` (a number, explicit null in every 11th record), `active` (a boolean, missing from every 13th) and `at` (a date-time every 97 s from 2020-01-01T00:00:00Z), all four declared filterable and backfilled ready. The measured collections (50,000, 200,000 and 500,000 records) share one space; another space holds 1,000,000 records of the same shape, so a measured collection is a fraction of the cell's `records` and `record_index_values`, as in a cell holding many spaces. The script seeds them directly in SQL as the writers store them: records, their typed index rows and, for the measured collections, their create events published to the feed. Reconciling the largest collection afterwards finds no drift, which checks the seed against what the writers derive.

Each [aggregation shape](#interactive-aggregations) runs three times through `PostgresAggregations` with its statement budget raised to its 15,000 ms maximum, so a shape past the 5,000 ms default is still measured, on an analytical pool that records the statement as issued. Its plan is that statement replayed under `EXPLAIN (ANALYZE, BUFFERS)` with the transaction's own settings (no parallel workers). Latency is the service's, admission included; the plan's time is the statement's.

The committed report ran on PostgreSQL 17.11 (pgvector image) in Docker on an 8-CPU Apple Silicon host shared with other work: its load average was 17.0 at the start and 19.2 at the end (28.5 over the last 15 minutes), so these numbers move between runs. An earlier run of the same settings and fixture, on the same host under a load average near 36, is quoted as *run 1* where it differs materially; its report, [`analysis-measurements-local-run1.json`](measurements/analysis-measurements-local-run1.json), comes from an earlier revision of the script, with one write round each way, one loaded phase (the 5 ms retries with the jobs Worker) and job rates by wall time. They measure this fixture on this server and set no product guarantee. The target, Railway Postgres, is measured by the same script with `DATABASE_URL` in external acceptance.

## Interactive aggregations

Median service latency of three runs, with the statement's own execution time from its plan in parentheses, in ms:

| Shape | 50,000 records | 200,000 | 500,000 | µs per record at 500,000 (run 1) | Plan at 500,000 |
| --- | --- | --- | --- | --- | --- |
| `count`: one group of all records | 164 (9) | 71 (37) | 359 (98) | 0.72 (0.31) | Index-only scan of the live records (`records_live_order`); reads no index values |
| `byValue`: by `team`, count, sum and average of `score` | 216 (141) | 691 (723) | 4,199 (4,727) | 8.40 (6.44) | Live records hash-joined with a sequential scan of `record_index_values` (210,454 buffers read) |
| `byMonth`: month buckets of `at` in America/New_York, count and maximum | 364 (332) | 1,345 (1,427) | 6,554 (7,228) | 13.11 (8.44) | As `byValue` |
| `threeDimensions`: by `team`, `active` and year of `at`, count and minimum | 510 (501) | 2,142 (2,264) | 9,777 (10,324) | 19.55 (12.97) | As `byValue`, three joins (315,750 buffers read) |
| `filteredBroad`: `team` equals one of 20 values, by `active` | 132 (34) | 357 (196) | 1,537 (1,656) | 3.07 | From `record_index_string`, each match's `active` by primary key |
| `filteredSelective`: `score` below 1,000, count and sum | 161 (10) | 69 (10) | 113 (11) | — | From `record_index_number`: 909 matches at every size |

- An unfiltered aggregation costs time in proportion to the collection's live records, and most of it is the per-record grouping work (bucketing an instant in a zone, three-key groups), not reading: the shapes over the same rows differ 2.3-fold. At 500,000 records `byMonth` and `threeDimensions` are past the 5,000 ms statement budget (in run 1, `threeDimensions` only, at 6,487 ms); every other shape answered within it.
- At 50,000 and 200,000 records, where the measured collection is a small share of `record_index_values`, the plan reads each field's rows through the table's primary key, merge- or hash-joined with the live records. At 500,000, 29% of the table's rows, the planner switches to a sequential scan of the whole table, the other space's rows included.
- A predicate starts the plan from its typed value index and costs what it matches: `filteredSelective` stays near 10 ms of statement time at every size. A filter is how an interactive aggregation stays within budget on a large collection.
- Service latency adds admission (directory, scope and declarations on the interactive pool) and the slot transaction; at small sizes it is dominated by them and by the host's load (`count` at 50,000 records took longer than at 200,000).

## Typed indexes and projections

The candidate is the one typed index the plans point at: each declared field's rows of a collection in record order, with their values, so each aggregated field is one index-only range instead of primary key lookups interleaved with the other fields' rows, or a scan of every space's rows:

```sql
CREATE INDEX record_index_by_field ON record_index_values(space_id,collection_id,field_name,record_id)
  INCLUDE (value_kind,string_value,number_value,boolean_value,time_value)
```

The script measures every shape with and without it at each size (built, measured, dropped), its build time and size, and record writes through the real write path in alternating rounds without and with it. Speedup is the median without it over the median with it:

| Shape | 50,000 | 200,000 | 500,000 | 500,000, run 1 |
| --- | --- | --- | --- | --- |
| `count` | 3.00 | 1.03 | 0.90 | 1.70 |
| `byValue` | 1.19 | 1.48 | 2.10 | 2.47 |
| `byMonth` | 1.36 | 1.19 | 1.83 | 1.43 |
| `threeDimensions` | 1.35 | 1.15 | 1.97 | 1.45 |
| `filteredBroad` | 1.23 | 1.92 | 1.52 | 1.53 |
| `filteredSelective` | 1.37 | 0.89 | 0.79 | 0.60 |

`count` reads no index values and its plan is the same either way, so its ratios are the host's noise, the noise floor of every ratio here. At 500,000 records the index replaces the whole-table scan (buffers read for `byValue`: 210,454 down to 26,990) and brings `byMonth` from 6,554 to 3,577 ms, within the budget, and `threeDimensions` from 9,777 to 4,975 ms. Its build took 17.5 to 35.4 s without `CONCURRENTLY`. It is 867 MB on 7.0 million rows: as large as the table itself (879 MB), and half again its eight existing indexes (1,785 MB). Record writes showed no cost from it under this host's load (p50 124.0 and 81.9 ms without it, 111.9 and 74.6 ms with it, 300 writes each, alternating); run 1's single pair was 37.5 ms without and 46.2 ms with it.

**Not added.** The gain is large only where one collection holds a large share of the cell's index rows, which turns the plan into a scan of the whole table; where it holds a small share, as in a cell holding many spaces, the index gains the unfiltered shapes 1.15 to 1.5 times, near the noise floor. Even at best it moves the slowest shape's ceiling from about 256,000 to about 500,000 records, while snapshot jobs already answer every collection up to their budgets and a filter answers selectively at any size. For that it would double the footprint of the cell's busiest write table, on every cell and for every collection whether it is ever aggregated or not, add a ninth index to every record write, and it made the selective filtered shape slower at 500,000 records in both runs. The [off-ramp](#off-ramp-to-a-dedicated-analytical-store) records when it would be justified; it would then land as a migration-only sub-slice, built concurrently as migration 050 is.

No maintained projection or partition is added either. A materialized aggregate projection (a rollup table kept by the jobs Worker) needs new tables, a maintainer and its own freshness and reconciliation, and nothing measured needs answers beyond the interactive ceiling sooner than a snapshot job gives them. Partitioning `record_index_values` by space would only shorten the whole-table scan above, the case the index addresses, at the cost of every writer, reader and the purge. What is added instead is the [freshness](#freshness) of the materialized results that exist, sealed snapshot job results, and the [reconciliation](#reconciliation) of the typed index projection every exact answer reads.

## Snapshot jobs

Both kinds over the 500,000-record collection, run by `PostgresAnalysisWorker.step` with a 10 s budget per step until complete (origin limit 20):

| Job | Result | Step time (what the 600 s budget counts) | Records per second of step time (run 1) | Wall time (run 1) | Steps (run 1) | As-of page read |
| --- | --- | --- | --- | --- | --- | --- |
| Export | 500 pages, 61,673,460 bytes | 114.4 s | 4,371 (11,070) | 167.4 s (53.3) | 330 (7) | 23.5 ms per 1,000 records |
| Aggregate (`byValue`) | 1 page, 5,974 bytes, after 500 page transactions | 86.5 s | 5,780 (12,308) | 104.6 s (49.3) | 12 (6) | 24.8 ms |

The as-of page read is the plan STA-57 and STA-59 describe: `records_byte_order` from the checkpoint, the watermark's revision by `record_event_feed_as_of`, the event by its unique key; about 24 µs per record, a tenth of a page transaction. Both jobs completed `exact` (nothing was written after their watermarks). In the committed run the export averaged 1.5 pages a step, against about 70 in run 1, so its wall time is half again its step time; the cause under this host's load was not isolated here, and the jobs Worker's step and tick latency on the target is STA-61's acceptance. Its 64 MiB byte budget is what ends a large export first ([limits](#limits)).

## Mixed load

Two composed application services, as two isolates (`postgresServices`, each with a 2-connection interactive pool and a 1-connection analytical pool, origin limit 5, so one analytical slot for the cell), over the 500,000-record collection. Through the first isolate's interactive pool, a loop reads a record by ID and counts `score < 1000` together (one pair) for 10 s per phase, while: nothing else runs; the jobs Worker steps an export; six aggregation loops per isolate run `byValue`, each retrying a refusal after 5 ms; the same loops retrying after 250 ms; both the 5 ms loops and the Worker. Interactive read pairs, in ms:

| Phase | Pairs | p50 | p95 | Max | Aggregations answered / refused | Peak aggregate statements | Job pages |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Interactive alone | 243 | 24.1 | 127.8 | 232.0 | — | 0 | — |
| Jobs Worker | 135 | 59.3 | 198.1 | 261.4 | — | 0 | 63 |
| Aggregations, retry after 5 ms | 70 | 127.7 | 316.9 | 405.3 | 3 / 988 | 1 | — |
| Aggregations, retry after 250 ms | 243 | 35.9 | 81.7 | 136.3 | 4 / 390 | 1 | — |
| Both, retry after 5 ms | 125 | 65.8 | 157.5 | 396.6 | 4 / 1,770 | 1 | 0 |

- No phase ran more aggregate statements at once than the cell's slots, and every interactive read pair finished within 405 ms (run 1, its loaded phase: 651 ms).
- Most of what aggregations take from interactive reads is the refused attempts, not the statements: each refused attempt is still admitted on the isolate's interactive pool (directory read, scope and declaration check), since [STA-58](analysis-aggregations.md#analytical-capacity) authorizes every aggregation before it takes capacity. Twelve clients retrying every 5 ms raise the read pairs' median five-fold; retrying after 250 ms answers as many aggregations and keeps the median within 12 ms of reads alone. So a `BACKPRESSURE` refusal is to be retried after at least 250 ms; STA-61's transports carry that as their retry hint.
- With one slot, aggregations retried every 5 ms take it each time it frees, and the export wrote no page in that phase (run 1: 5). At an origin limit of 5 a cell's interactive aggregations and jobs share one slot; a cell with steady analytical demand needs a larger origin limit (4 slots at 20).

## Limits

Each analytical bound, its value and what the measurements say about it. All values are kept: none was found unsafe, and the ones that bind first are named.

| Bound | Value | Evidence | Outcome |
| --- | --- | --- | --- |
| Aggregation statement time | 5,000 ms (a service option, 1 to 15,000) | Unfiltered cost is linear: 0.72, 8.40, 13.11 and 19.55 µs per record at 500,000 for `count`, `byValue`, `byMonth` and `threeDimensions` (run 1: 0.31, 6.44, 8.44, 12.97), so within 5 s up to about 6,970,000, 595,000, 381,000 and 256,000 records (run 1: 16,000,000, 777,000, 593,000, 385,000). Filtered shapes cost what they match (11 ms for 909 matches at 500,000) | Kept. Larger collections are answered with a filter or by a snapshot job; the [candidate index](#typed-indexes-and-projections) would raise the grouped ceilings by at most about 2 times |
| Groups and result bytes | 1,000 groups (100 by default), 262,144 bytes | They bound the reply, not the work: the measured shapes return 1 to 80 groups and cost per record. STA-58's tests cover each cap | Kept |
| Analytical slots | 1 per 5 origin connections (1 at 5, 4 at 20), half of them per space, at least 1 | Aggregate statements never outnumbered the cell's slots in any phase; interactive read pairs stayed within 405 ms under every load (651 ms in run 1) | Kept. At 5 origin connections one slot serves both aggregations and jobs, and aggregations retrying fast starve jobs ([mixed load](#mixed-load)) |
| Analytical session checkout | 2,000 ms | STA-58's bounded checkout tests | Kept |
| Job records scanned | 10,000,000 | Not reached: the step time and byte budgets end a job first on this host | Kept, the outer bound for a faster target |
| Job step time | 600,000 ms | 4,371 (export) and 5,780 (aggregate) records per second of step time (run 1: 11,070 and 12,308), so about 2,620,000 and 3,470,000 records (run 1: 6,640,000 and 7,380,000) | Kept. It ends an aggregate job first |
| Job result bytes | 64 MiB | 123 bytes of NDJSON per fixture record, so an export of about 544,000 such records; an aggregate's one page is a few KiB | Kept. It ends an export first: a larger export fails with `BUDGET_EXCEEDED` (STA-61 records the export limits on its transports) |
| Page | 1,000 records and 1 MiB | The as-of read takes 23.5 ms of a 229 ms export page transaction (run 1: 15.3 of 90) | Kept |
| Lease | 30 s, extended by every page | Page transactions of 0.09 to 0.23 s | Kept |
| Jobs Worker analysis step | 5 s per tick | 4,371 to 11,070 records per step-second: about 22,000 to 55,000 records a minute per cell, so a 500,000-record export in 9 to 23 ticks | Kept |
| Reconciliation | 1,000 records a page, 10,000 a call by default, 1,000,000 at most | 11,673 records per second (run 1: 17,363) over 500,000 records and four fields | New in this slice |
| Unfinished jobs per space (8), lifetime (24 h), publication at submission (20 rounds of 5,000), spec (32 KiB serialized, 64 KiB stored), checkpoint (1 MiB) | — | Structural protective bounds on admission and storage, not capacity; not measured here | Kept |

## Freshness

Every result says whether it is still the collection's:

| Result | `freshness` | Meaning |
| --- | --- | --- |
| Interactive aggregation (`analysis.aggregate`) | `{ state: 'exact', checkedAt }`, `checkedAt` equal to `snapshot.takenAt` | Always exact: the groups are the live records' own as one statement read them through the typed index, never a materialized copy. Per metric and dimension, `semantics` still says `exact` or `derived` (an average, a time bucket) |
| Snapshot job status, submission and page (`analysis.submit`, `status`, `page`) | `{ state: 'exact' \| 'stale', checkedAt, latestPosition, unpublished, schemaVersion }` | `exact` when, as of `checkedAt` (the reading statement's snapshot), no write to the collection was published past the job's watermark (`latestPosition`, the collection's last feed position, is at most the watermark), none awaits publication (`unpublished` is false) and the collection's schema version is the one pinned. Otherwise `stale`: the materialized result is still exact as of its watermark, and the writes after it are not in it |

The freshness is read in the same statement as the job's status, with the scope locks, grant check and final credential check every job read takes, so it never discloses more than the caller's capability on the collection allows: the collection's own last feed position and whether it has unpublished writes. A write committing after that statement is not seen; `checkedAt` says when it was taken. A stale result is never refreshed in place: submit a new job, whose watermark covers the writes. The export and aggregate pages themselves are immutable and carry their boundary (`watermark`, `records: 'as-of-watermark'`); freshness is reported beside them, never inside the sealed content.

A materialized result in this slice is a sealed snapshot job result: the measurements justify no maintained aggregate projection (see [typed indexes and projections](#typed-indexes-and-projections)), so there is no other copy to label.

## Reconciliation

`record_index_values` is a typed projection of each record's canonical data: record writers and backfill derive one row per live record and declared field (`missing` or `null` included), and every exact query, count, sort and interactive aggregation reads it as the truth. Readiness and migration 031's commit check guarantee a row exists; nothing checked until now that it holds what the data derives. A faulty writer, a partial restore or a manual repair could make an `exact` answer wrong without any error.

`reconcileIndexes(pool, spaceId, collectionId, { after?, maxRecords? })` (`packages/postgres/src/index-reconciliation.ts`) compares them:

- It pages through the collection's records (live and deleted) in record ID order, 1,000 at a time, at most `maxRecords` (10,000 by default, 1 to 1,000,000) per call, and returns `next`, the last record checked, to continue from with `after` (null once the collection was read to its end).
- Each page is one `REPEATABLE READ, READ ONLY` transaction: the collection's current definition, its ready declarations, the records and their rows are one snapshot, so a write committing meanwhile is never drift. A declaration still backfilling is not checked; `fields` lists those that were.
- Each live record's value of each ready field is derived as the writers and backfill derive it (`derivedIndexValue` under the current definition) and compared with its row in the database's own types (`numeric`, `text COLLATE "C"`, `boolean`), so a change past a double's precision is still found.
- Drift is reported per record and field as `missing` (a live record without a row), `unexpected` (a deleted record still holding one), `kind`, `value`, or `underivable` (the stored data no longer derives a value: a date-time field holding a non-instant), with the expected and actual kinds and never a value. `driftCount` counts all; at most 100 are listed.

It only reads and never repairs: drift on a ready field means exact answers over that collection may be wrong and is an incident to investigate. A live record's rows are rewritten by its next write. `pnpm db:reconcile-indexes --space ID --collection ID [--after RECORD_ID] [--max-records N]` runs it through `DATABASE_URL` (loopback, or `sslmode=verify-full`, as every operator script connects), prints the report as JSON and exits 1 when drift is found. It needs only `SELECT` on `records`, `record_index_values`, `collections`, `collection_versions` and `collection_index_declarations`, the tables every record read already reads. It authorizes no caller and reads every record of the collection, so it is an operator check, not a client operation. Measured on the fixture's 500,000-record collection: 11,673 records per second over four fields (run 1: 17,363), so about 43 s per 500,000 records.

## Off-ramp to a dedicated analytical store

Postgres stays the analytical store while the measured patterns fit their budgets. Measure the target with this script and the cell's own counters, and take the next step when any of these holds over a representative week:

1. **The typed index** above, as a migration-only sub-slice built concurrently: when interactive aggregations over a collection that holds a large share of its cell's index rows are refused with `time` in regular use, and the target measures the index's record write cost below 5%.
2. **A maintained aggregate projection in Postgres** (rollup tables kept from the event feed, with freshness and reconciliation as here; its migration first, as its own sub-slice): when the same aggregate spec over a collection past the [interactive ceiling](#limits) is requested again before a snapshot job over it would complete.
3. **A dedicated analytical store** (a columnar replica fed from the event feed, keeping as-of watermarks, authorization and freshness as here), when any of these holds:
   - collections that must be analysed whole exceed what one snapshot job covers within its budgets (here about 2.6 million records by step time, and about 544,000 records of this size by bytes for an export), and raising those budgets would hold analytical capacity past the jobs Worker's tick;
   - at the largest origin limit (4 analytical slots at 20), more than half of aggregation attempts are refused with `slots` over an hour, with clients retrying after 250 ms;
   - interactive reads' p95 under analytical load, with clients retrying after 250 ms and the jobs Worker running, exceeds twice their p95 without it on the target (here 82 and 198 ms against 128 ms alone).

None of these holds on the measured fixture, so Postgres stays the analytical store.

## Evidence

- `test/integration/analysis-measurements.test.js` (in `pnpm test:postgres`): reconciliation finds a clean collection clean and reports each kind of drift (a value changed past a double's precision, a kind, a lost row, a deleted record's row, data that no longer derives) by record and field, never by value, through the function and the operator script (exit 1); pages continue from `next`; a field still backfilling is not drift and is checked once ready; a record replaced between a page's read of the records and of their rows is not drift (read at `READ COMMITTED` instead, the same test reports three); and the measurement script at a small scale reports every shape's plan as issued (no parallel workers), the candidate's speedup, build, size and interleaved write rounds, both jobs complete and exact through the as-of index, no drift, every load phase within the analytical slots and the limits, and drops its database.
- `test/integration/analysis-jobs.test.js`: a job is exact when submitted and once complete (its groups equal the interactive aggregation's), stays exact after a write to another collection, turns stale with `unpublished` at once after a committed but unpublished delete, then by position once it is published (its page unchanged), a job pinned later is exact again until the schema version changes; the interactive aggregation states `exact` at its statement time.
- The committed report, by `pnpm analysis:measure --scales 50000,200000,500000 --noise 1000000 --runs 3 --load-seconds 10 --writes 300 --out docs/measurements/analysis-measurements-local.json`.

These are local measurements. Railway Postgres is measured by the same script in external acceptance; the jobs Worker cron through Hyperdrive on Cloudflare Preview is STA-61's.
