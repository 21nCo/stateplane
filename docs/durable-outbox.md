# Durable outbox and regional jobs (STA-12)

Each regional cell's Postgres outbox is the only durable record of projection work. Every record write already commits its row, event, receipt and `projection_outbox` entry atomically. Cloudflare only carries delivery hints and runs bounded ticks. Delivery is at least once and completion may arrive in any order; correctness comes from SQL fences, not from transport ordering or exactly-once delivery. This is product-internal infrastructure. Clients see the existing `pending`/`current`/`degraded` projection state, not a job API.

## Delivery path

1. **Dispatch.** The cell jobs Worker's cron tick calls `PostgresOutbox.claim`. In one transaction it leases due rows (`delivering`, `attempts + 1`, dispatch lease) and advances a single-row checkpoint, then sends `{eventId, attempt}` hints to the cell Queue. Rows of suspended, deleting or deleted spaces and of deleted collections are not leased.
2. **Start.** A consumer calls `process(hint)`. The first start of a current, unexpired lease sets `started_attempt` and replaces the dispatch lease with a 60-second processing lease. A duplicate or stale hint matches nothing and returns `lost`.
3. **Prepare.** An optional projector `prepare` step, such as an embedder call, runs outside any SQL transaction within a 45-second budget.
4. **Complete.** `AuthorityTransaction.completeProjection` runs under the `system:projection` worker scope with the space's *current* policy version and placement generation. It locks the outbox row, rechecks the lease, then advances the per-ref `projection_heads` row only forward by `(generation, revision)` and calls the projector's `apply` in the same transaction. The row becomes `delivered` with outcome `applied` or `superseded`.

| Failure | Result |
| --- | --- |
| Dispatcher crashes after claim, before send | The unstarted lease expires and is reclaimed. No failure is counted. |
| Queue send fails | Every lease from that batch is released at once. A hint that did arrive names a released attempt and is fenced. |
| Duplicate or late hint | Start or completion matches nothing: `lost`. |
| Worker crashes or overruns after start | The processing lease expires; the next claim counts one failure and leases a new attempt. A delayed completion of the old attempt is fenced. |
| Projector error or 45-second overrun | One failure with backoff from 5 seconds doubling to one hour. |
| Policy, lifecycle or collection change mid-flight | The completion is denied, the lease is released without a failure, and a later claim re-runs it under current scope. |
| Older revision completes after a newer one or after a delete | The head does not move: `superseded`. A late update cannot resurrect a deleted ref. |
| Work captured under an earlier placement generation | It never applies. The latest revision is requeued under the current generation (`requeued`); older revisions are `superseded`. |

After eight counted failures the row becomes a **dead letter**: it stays `degraded`, `dead_lettered_at` is set and it is parked at `available_at = 'infinity'`, after every due row in the claim index. Other refs and spaces continue. Projection status reports the record as `degraded` until an operator retries it.

A `requeued` or newer `pending` row makes projection status `pending`. A delivered latest revision is `current` only under the space's current placement generation. Exact reads and writes never wait for projection work. A Queue, Worker or projector outage leaves rows `pending`/`degraded` and visible in status. It does not stop available authoritative record paths.

Projection delivery does not depend on the writer's credential. Projecting a committed revision is system work over data the space already holds. Each completion is re-authorized under the space's current lifecycle, policy version and placement, not under the claim's. The only resumable job here, reconciliation, is operator-initiated. Later owner-initiated jobs, such as STA-15 exports, must recheck their initiating credential at each step.

## Fairness and bounds

A claim walks distinct live `(space, collection)` pairs through the existing claim index with a recursive scan. It starts after the checkpoint cursor and wraps once. It takes at most `perSpace` due rows per space, then interleaves spaces by turn before applying `limit`. The cursor rotates the scanned pairs across ticks, so a large backlog cannot keep later spaces out. Each pair contributes at most `perSpace` rows, so the candidate set is bounded by `pairs × perSpace`. The scan itself visits live index entries of the bounded pair range only.

| Bound | Initial value | Purpose |
| --- | --- | --- |
| Claim `limit` / `perSpace` / `pairs` | 100 / 25 / 200 (max 100 / limit / 1,000) | One transaction's locks; one Queue `sendBatch` (Cloudflare's 100-message cap); scan work per tick |
| Dispatch lease | 300 s (1–3,600) | Hint transit before an unstarted lease is reclaimed |
| Processing lease / budget | 60 s / 45 s | Crash detection; one item's prepare plus completion |
| Failures before dead letter | 8 (5 s → 1 h backoff) | Poison isolation after about ten minutes of retries |
| Consumer concurrency | 4 per batch (max 16) | Bounded Worker work; Queue `max_batch_size` stays 1 |
| Reconciliation | 4 jobs × 100 records per tick (max 32 × 500) | Bounded, resumable repair |
| SQL statements | 5 s | Short cell transactions |

These are initial protective bounds chosen from the transaction and Queue limits above, not measured Railway, Hyperdrive or Queue capacity. STA-19 owns measured limits. Queue retries (`max_retries: 3`) and its dead-letter queue only carry hints. Losing a hint costs one lease interval, never committed work.

## Operator API

`PostgresOutbox` is the product-internal operator API. `pnpm db:outbox` exposes it with `DATABASE_URL` set to the cell's private URL:

```sh
pnpm db:outbox status [spaceId]
pnpm db:outbox job <jobId>
STATEPLANE_OPERATOR=<name> pnpm db:outbox retry <spaceId> [collectionId] --reason <text>
STATEPLANE_OPERATOR=<name> pnpm db:outbox reconcile <spaceId> <collectionId> --reason <text>
STATEPLANE_OPERATOR=<name> pnpm db:outbox cancel <jobId> --reason <text>
```

- **Status** reports, per space and collection, pending, delivering, degraded and dead-letter counts. It also reports the oldest undelivered commit time, lag in seconds and the newest error, plus the dispatcher's last tick and recent reconciliations. It reads the live claim index, so its cost grows with the backlog, not with delivered history. Output is capped at 1,000 rows.
- **Retry** returns a space's or collection's dead letters to the due queue with a fresh failure budget.
- **Reconcile** starts, or returns, the one running reconciliation for a collection. Each step pages records by ID from a durable checkpoint. It requeues a record's latest revision when that revision was delivered but its head is missing, behind or from an earlier placement generation. It skips live rows and dead letters. Use it after a placement fence or a restore without projection state, or for refs delivered before migration 039 that have no head.
- **Cancel** stops a running reconciliation before its next page. Already requeued work stays queued.

Retry, reconcile and cancel each write an immutable `outbox_operator_audit` row with the operator, reason, job and affected count. Like space audits, these rows survive space erasure. A reason must not contain record content. Projector error text is stored as a bounded diagnostic and shown by status, so projectors must not include record content in errors.

## Deployment and migration

Migration 039 adds outbox columns with constant defaults and `NOT VALID` checks. That is a brief exclusive lock on `projection_outbox` without a rewrite or scan. Existing rows trivially satisfy the checks, and later writes are checked. It also adds new tables and replaces `stateplane_purge_space` so erasure removes heads and reconciliation jobs before records. No drain is required. Refs delivered before 039 have no head. Reconcile each collection after upgrading to record their heads.

After migration and after restore of each cell, run `pnpm db:grant-outbox` through the direct administrative connection with `STATEPLANE_CELL_ADMIN_URL` and the protected inventory's `STATEPLANE_CELL_ROLE`. It grants the operational role `SELECT, INSERT, UPDATE` on `projection_heads` and `projection_reconciliations`, `SELECT, UPDATE` on `outbox_dispatch_checkpoint` and `SELECT, INSERT` on `outbox_operator_audit`. It then reads each privilege back. The role needs no `DELETE` on these tables; erasure uses the purge routine.

The rendered cell jobs Worker now has a once-a-minute cron trigger and a producer binding for its own projection Queue, in addition to the consumer. Until STA-14 adds a search projector, completion only advances heads and receipts. A Worker dry-run bundles this code. Deployed Queue, cron and Hyperdrive behavior requires the cell acceptance in STA-21.

## Verification

`pnpm test:postgres` runs `test/integration/durable-outbox.test.js` against a disposable database. It injects failed and partial sends, dispatcher crashes, duplicate, concurrent and stale hints, and reordered and concurrent completions with deletes. It also covers started-lease expiry with a delayed old worker, poison items reaching the dead letter, operator retry and audit, placement fences and mid-flight policy changes, suspension, per-space fairness and cursor rotation, projection outage alongside authoritative writes and reads, and checkpointed, restarted and cancelled reconciliation with erasure. `test/outbox-runtime.test.js` covers the transport-agnostic dispatcher and consumer.
