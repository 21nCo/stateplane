# Durable outbox and regional jobs (STA-12)

Each regional cell's Postgres outbox is the only durable record of projection work. Every record write already commits its row, event, receipt and `projection_outbox` entry atomically. Cloudflare only carries delivery hints and runs bounded ticks. Delivery is at least once and completion may arrive in any order; correctness comes from SQL fences, not from transport ordering or exactly-once delivery. This is product-internal infrastructure. Clients see the existing `pending`/`current`/`degraded` projection state, not a job API.

## Delivery path

1. **Dispatch.** The cell jobs Worker's cron tick calls `dispatch`, which repeats `PostgresOutbox.claim` and a Queue `sendBatch` until nothing is due or the tick's budget is spent. Each claim leases due rows in one transaction (`delivering`, `attempts + 1`, dispatch lease), advances a single-row checkpoint and sends `{eventId, attempt}` hints to the cell Queue. Rows of suspended, deleting or deleted spaces and of deleted collections are not leased.
2. **Start.** A consumer calls `process(hint)`. The start transaction locks the outbox row and reads the space and collection. Only the first start of a current, unexpired lease proceeds. A duplicate or stale hint matches nothing and returns `lost`. Before any projector callback sees record content, start fences scope. If the space is no longer `active`/`readOnly` or the collection is deleted, the lease is released without a failure (`released`). If the row was captured under an earlier placement generation, the projector does not run and completion only requeues or supersedes it. Otherwise start sets `started_attempt` and replaces the dispatch lease with a 60-second processing lease.
3. **Prepare.** An optional projector `prepare` step, such as an embedder call, runs outside any SQL transaction.
4. **Complete.** `AuthorityTransaction.completeProjection` runs under the `system:projection` worker scope with the policy version and placement generation read at start. Its scope check denies the completion if either changed. It locks the outbox row, rechecks the lease, then advances the per-ref `projection_heads` row only forward by `(generation, revision)` and calls the projector's `apply` in the same transaction. The row becomes `delivered` with outcome `applied` or `superseded`.

One 45-second budget covers prepare, apply and completion. When it expires, a pending `prepare` or `apply` is abandoned, the transaction issues no further SQL and rolls back, and the lease records one failure. Statements are bounded by the remaining budget. During `apply` the transaction also sets `idle_in_transaction_session_timeout` to the remaining budget, so a worker that stops responding cannot hold the ref's locks past it.

| Failure | Result |
| --- | --- |
| Dispatcher crashes after claim, before send | The unstarted lease expires and is reclaimed. No failure is counted. |
| Queue send fails | Every lease from that batch is released at once. A hint that did arrive names a released attempt and is fenced. |
| Duplicate or late hint | Start or completion matches nothing: `lost`. |
| Worker crashes or overruns after start | The processing lease expires; the next claim counts one failure and leases a new attempt. A delayed completion of the old attempt is fenced. |
| Projector error, or prepare/apply/completion overrunning the 45-second budget | One failure with backoff from 5 seconds doubling to one hour. A hung `apply` cannot commit late. |
| Infrastructure error after start with a known rollback, such as a lost connection or a lock budget | The lease is released without a failure, and the error is rethrown so the hint is retried. An unknown COMMIT outcome keeps the lease; if it did not commit, its expiry counts. |
| Space suspended or collection deleted before start | Released at start without a failure and without any projector callback. |
| Policy, lifecycle or collection change after start | The completion is denied, the lease is released without a failure, and a later claim re-runs it under current scope. |
| Older revision completes after a newer one or after a delete | The head does not move: `superseded`. A late update cannot resurrect a deleted ref. |
| Work captured under an earlier placement generation | It never applies and no projector callback runs. The latest revision is requeued under the current generation (`requeued`); older revisions are `superseded`. |
| Placement fence after delivery | `PostgresSpaces.fencePlacement` schedules a `placement` reconciliation for every live collection in the fence's cell transaction, restarting any running pass. Ticks then requeue each delivered latest revision under the new generation with no operator step. Status lists the running repair. |

After eight counted failures the row becomes a **dead letter**: it stays `degraded`, `dead_lettered_at` is set and it is parked at `available_at = 'infinity'`, after every due row in the claim index. Other refs and spaces continue. Projection status reports the record as `degraded` until an operator retries it.

A `requeued` or newer `pending` row makes projection status `pending`. A delivered latest revision is `current` only under the space's current placement generation. Exact reads and writes never wait for projection work. A Queue, Worker or projector outage leaves rows `pending`/`degraded` and visible in status. It does not stop available authoritative record paths.

Projection delivery does not depend on the writer's credential. Projecting a committed revision is system work over data the space already holds. Each start and completion is re-authorized under the space's current lifecycle, policy version and placement, not under the claim's. The only resumable job here, reconciliation, is started by an operator or by a placement fence. Later owner-initiated jobs, such as STA-15 exports, must recheck their initiating credential at each step.

## Fairness and bounds

A claim walks distinct live `(space, collection)` pairs through the existing claim index with a recursive scan. It starts after the checkpoint cursor and wraps once. It takes at most `perSpace` due rows per space, then serves spaces by turn and, within a turn, in cursor order before applying `limit`. When `limit` cuts a claim short, the cursor moves past the last pair served, so the next claim starts with the pairs that missed out. When the scan budget cuts it short, the cursor moves past the last pair scanned. Repeated claims within one tick therefore rotate service across spaces, and one old backlog cannot be served ahead of every other space. Each pair contributes at most `perSpace` rows, so the candidate set is bounded by `pairs × perSpace`. The scan itself visits live index entries of the bounded pair range only.

| Bound | Initial value | Purpose |
| --- | --- | --- |
| Claim `limit` / `perSpace` / `pairs` | 100 / 25 / 200 (max 100 / limit / 1,000) | One transaction's locks; one Queue `sendBatch` (Cloudflare's 100-message cap); scan work per claim |
| Dispatch tick | Once a minute; claim and send for up to 20 s, then reconciliation steps for up to 10 s | Throughput per cell without overlapping ticks. A tick can overrun by one claim and send. |
| Dispatch lease | 300 s (1–3,600) | Hint transit before an unstarted lease is reclaimed |
| Processing lease / budget | 60 s / 45 s | Crash detection; one item's prepare, apply and completion |
| Failures before dead letter | 8 (5 s → 1 h backoff) | Poison isolation after about ten minutes of retries |
| Consumer concurrency | 4 per batch (max 16) | Bounded Worker work; Queue `max_batch_size` stays 1 |
| Reconciliation step | 4 jobs × 100 records per call (max 32 × 500), repeated for up to 10 s per tick | Bounded, resumable repair |
| Status | 200 collections × the 500 oldest-due live rows each | Status stays usable during the backlog it reports |
| SQL statements | 5 s | Short cell transactions |

These are initial protective bounds chosen from the transaction and Queue limits above, not measured Railway, Hyperdrive or Queue capacity. STA-19 owns measured limits.

The dispatch ceiling per cell is about `20 s ÷ (claim round trip + sendBatch round trip) × 100` hints per minute. It is bounded by those two round trips, by `perSpace` for a single busy space (25 per claim), and by Queue and consumer throughput. Local evidence only (pgvector Postgres 17 on the same host, no-op transport, 375,000 live rows over 250 collections): one 20-second tick leased 87,400–91,100 rows in 874–911 claims, about 4,000–4,500 rows per second, and status took 0.44–0.87 s. Hyperdrive and Queue latency will lower the deployed figure. STA-19 and STA-21 measure it. Queue retries (`max_retries: 3`) and its dead-letter queue only carry hints. Losing a hint costs one lease interval, never committed work.

## Operator API

`PostgresOutbox` is the product-internal operator API. `pnpm db:outbox` exposes it with `DATABASE_URL` set to the cell's private URL:

```sh
pnpm db:outbox status [spaceId]
pnpm db:outbox job <jobId>
STATEPLANE_OPERATOR=<name> pnpm db:outbox retry <spaceId> [collectionId] --reason <text>
STATEPLANE_OPERATOR=<name> pnpm db:outbox reconcile <spaceId> <collectionId> --reason <text>
STATEPLANE_OPERATOR=<name> pnpm db:outbox cancel <jobId> --reason <text>
```

- **Status** reports, per space and collection, pending, delivering, degraded and dead-letter counts. It also reports the oldest undelivered commit time, lag in seconds and the newest error, plus the dispatcher's last tick and running or recent reconciliations with their `cause` (`operator` or `placement`). It reads the live claim index for at most 200 collections and, per collection, the 500 oldest-due live rows. `capped: true` marks counts that are lower bounds, and `more: true` means further collections have live rows. Pass a space ID to narrow the report.
- **Retry** returns a space's or collection's dead letters to the due queue with a fresh failure budget.
- **Reconcile** starts, or returns, the one running reconciliation for a collection. Each step pages records by ID from a durable checkpoint. It requeues a record's latest revision when that revision was delivered but its head is missing, behind or from an earlier placement generation. It skips live rows and dead letters. A placement fence schedules this automatically. Run it after a restore without projection state, or for refs delivered before migration 039 that have no head.
- **Cancel** stops a running reconciliation before its next page. Already requeued work stays queued.

Retry, reconcile and cancel each write an immutable `outbox_operator_audit` row with the operator, reason, job and affected count. Like space audits, these rows survive space erasure. A reason must not contain record content. Projector error text is stored as a bounded diagnostic and shown by status, so projectors must not include record content in errors.

## Deployment and migration

Migration 039 first takes `SHARE ROW EXCLUSIVE` on `spaces`, `collections` and `records`, then `ACCESS EXCLUSIVE` on `projection_outbox`. That is record writers' lock order, so the step cannot deadlock with a writer. It holds these locks until the migration commits. While it waits or holds them, record writes, space and collection updates and every outbox read wait too. The migrator bounds each wait with `lock_timeout = 5s`. A live writer or a long outbox reader makes it fail with `Durable outbox upgrade requires drained traffic; stop record writers and long outbox readers, then retry`, with nothing applied. Run it in a drained window. The outbox columns have constant defaults and `NOT VALID` checks, so there is no rewrite or scan. Existing rows trivially satisfy the checks, and later writes are checked. It also adds new tables and replaces `stateplane_purge_space` so erasure removes heads and reconciliation jobs before records. Refs delivered before 039 have no head. Reconcile each collection after upgrading to record their heads.

After migration and after restore of each cell, run `pnpm db:grant-outbox` through the direct administrative connection with `STATEPLANE_CELL_ADMIN_URL` and the protected inventory's `STATEPLANE_CELL_ROLE`. It grants the operational role `SELECT, INSERT, UPDATE` on `projection_heads` and `projection_reconciliations`, `SELECT, UPDATE` on `outbox_dispatch_checkpoint` and `SELECT, INSERT` on `outbox_operator_audit`. It then reads each privilege back. The role needs no `DELETE` on these tables; erasure uses the purge routine.

The rendered cell jobs Worker now has a once-a-minute cron trigger and a producer binding for its own projection Queue, in addition to the consumer. `db:restore-smoke` restores the four new tables and reapplies these grants. Until STA-14 adds a search projector, completion only advances heads and receipts. A Worker dry-run bundles this code. Deployed Queue, cron and Hyperdrive behavior requires the cell acceptance in STA-21.

## Verification

`pnpm test:postgres` runs `test/integration/durable-outbox.test.js` against a disposable database. It injects failed and partial sends, dispatcher crashes, duplicate, concurrent and stale hints, and reordered and concurrent completions with deletes. It also covers started-lease expiry with a delayed old worker, poison items reaching the dead letter, and operator retry and audit, including a rejected `TRUNCATE`. Further cases cover placement fences and mid-flight policy changes, and suspension, collection deletion and placement change between claim and start, each checked with a projector spy. A hung and a late `apply` are bounded by the budget. A rolled-back infrastructure error does not spend the failure budget. It also covers per-space fairness, cursor rotation and service rotation across claims, a budgeted tick draining several claims, and a real `fencePlacement` converging with no operator step. Projection outage alongside authoritative writes and reads is covered, as is checkpointed, restarted and cancelled reconciliation with erasure. `test/integration/event-feed-upgrade.test.js` shows a long outbox reader making 039 fail fast with the drain error. `test/outbox-runtime.test.js` covers the transport-agnostic dispatch loop and consumer.
