import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';
import { migrationInventory, migrationOrder } from './migration-order.mjs';

const client = new pg.Client(connectionOptions(process.env.DATABASE_URL));
const directory = resolve(import.meta.dirname, '../migrations');
let transactionOpen = false;
let advisoryLockHeld = false;
try {
  await client.connect();
  // Hold one session lock across the transaction boundary between the staged
  // batch CHECK creation and validation. Each ledger write remains atomic with
  // its SQL file, including when validation is retried after interruption.
  // Wait for it by polling, not inside one statement: a waiting statement holds
  // a snapshot, which a concurrent index build (047) waits for in turn.
  while (!(await client.query('SELECT pg_try_advisory_lock(73003) AS held')).rows[0].held)
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  advisoryLockHeld = true;
  // Set isolation before the migration ledger can establish a snapshot.
  // Administrative defaults may otherwise make the post-lock outbox
  // preflight read a snapshot from before an in-flight writer committed.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  transactionOpen = true;
  await client.query('CREATE TABLE IF NOT EXISTS stateplane_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = await migrationInventory(directory);
  const applied = await client.query('SELECT name, sha256 FROM stateplane_migrations');
  const recorded = new Map(applied.rows.map(row => [row.name, row.sha256]));
  const recordedNames = [...recorded.keys()].sort(migrationOrder);
  for (const [index, name] of recordedNames.entries()) {
    if (files[index] !== name) throw new Error(`Migration drift: applied history is not a prefix of current files at ${name}`);
  }
  const pendingOutboxIndexBuild = files.some(name =>
    (name === '005_scoped_query_indexes.sql' || name === '006_outbox_due_order.sql') && !recorded.has(name));
  const pendingProjectionUpgrade = files.includes('031_index_missing_projection.sql') && !recorded.has('031_index_missing_projection.sql');
  const pendingEventFeedUpgrade = ['036_event_cursor.sql','037_commit_safe_event_feed.sql',
    '038_drop_superseded_event_cursor.sql']
    .some(name => files.includes(name) && !recorded.has(name));
  if (pendingOutboxIndexBuild && process.env.STATEPLANE_POPULATED_INDEX_UPGRADE !== 'drained') {
    const relation = await client.query("SELECT to_regclass('public.projection_outbox') AS name");
    if (relation.rows[0].name !== null) {
      // Hold the emptiness decision through migration commit. SHARE excludes writers and
      // claim updates, and waits for any writer that began before this preflight.
      const previousLockTimeout = (await client.query('SHOW lock_timeout')).rows[0].lock_timeout;
      if (previousLockTimeout === '0') await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('LOCK TABLE public.projection_outbox IN SHARE MODE');
      if (previousLockTimeout === '0') await client.query("SET LOCAL lock_timeout = '0'");
      const populated = await client.query('SELECT EXISTS (SELECT 1 FROM public.projection_outbox) AS present');
      if (populated.rows[0].present) {
        throw new Error('Populated outbox index upgrade requires drained traffic; set STATEPLANE_POPULATED_INDEX_UPGRADE=drained only after stopping claim workers and writers');
      }
    }
  }
  if (pendingProjectionUpgrade) {
    const relations = await client.query(`SELECT to_regclass('public.collection_index_declarations') AS declarations,
      to_regclass('public.records') AS records`);
    if (relations.rows[0].declarations && relations.rows[0].records) {
      // Backfill takes a declaration lock before touching records or index rows.
      // Take that lock first so the 031 DDL cannot invert the order.
      const previousLockTimeout = (await client.query('SHOW lock_timeout')).rows[0].lock_timeout;
      if (previousLockTimeout === '0') await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('LOCK TABLE public.collection_index_declarations IN SHARE ROW EXCLUSIVE MODE');
      // SHARE ROW EXCLUSIVE still permits a backfill's ROW SHARE table lock.
      // Lock its declaration rows before touching either records or index DDL.
      // The aggregate returns one row even for a large declaration inventory.
      await client.query(`SELECT count(*)::bigint FROM (
        SELECT 1 FROM public.collection_index_declarations
        ORDER BY space_id,collection_id,field_name FOR NO KEY UPDATE) locked`);
      // An older writer can hold a records lock before requesting its index FK.
      // Refuse immediately instead of waiting behind it while holding the
      // declaration lock and forming a cycle.
      try { await client.query('LOCK TABLE public.records IN SHARE MODE NOWAIT'); }
      catch (error) {
        if (error?.code === '55P03') throw new Error('Projection upgrade requires drained traffic; stop active record writers and backfill workers before retrying', { cause:error });
        throw error;
      }
      if (previousLockTimeout === '0') await client.query("SET LOCAL lock_timeout = '0'");
      const populated = await client.query('SELECT EXISTS (SELECT 1 FROM public.records) AS present');
      if (populated.rows[0].present && process.env.STATEPLANE_POPULATED_INDEX_UPGRADE !== 'drained') {
        throw new Error('Populated projection upgrade requires drained traffic; set STATEPLANE_POPULATED_INDEX_UPGRADE=drained only after stopping record writers and backfill workers');
      }
    }
  }
  const preflightEventFeed = async () => {
    const relations = await client.query(`SELECT to_regclass('public.records') AS records,
      to_regclass('public.record_events') AS events`);
    if (relations.rows[0].events) {
      // A record writer can touch records before it inserts an event. Lock in
      // that order and refuse contention instead of waiting behind a writer
      // while holding a lock it needs to finish. Keep both locks until commit
      // so the emptiness check and historical feed backfill cannot race writes.
      try {
        if (relations.rows[0].records) await client.query('LOCK TABLE public.records IN SHARE MODE NOWAIT');
        await client.query('LOCK TABLE public.record_events IN SHARE MODE NOWAIT');
      } catch(error) {
        if (error?.code === '55P03')
          throw new Error('Event feed upgrade requires drained traffic; stop active record writers before retrying', {cause:error});
        throw error;
      }
      const populated = await client.query('SELECT EXISTS (SELECT 1 FROM public.record_events) AS present');
      if (populated.rows[0].present && process.env.STATEPLANE_POPULATED_INDEX_UPGRADE !== 'drained')
        throw new Error('Populated event feed upgrade requires drained traffic; set STATEPLANE_POPULATED_INDEX_UPGRADE=drained only after stopping record writers');
    }
  };
  // 039 builds two indexes over projection_outbox while writers queue behind
  // its locks. Take those locks in 039's own writer order under its bounded
  // wait, so the emptiness decision holds through commit, and require the
  // drained acknowledgement before building over existing rows.
  const preflightDurableOutbox = async () => {
    await client.query('LOCK TABLE public.spaces, public.collections, public.records IN SHARE ROW EXCLUSIVE MODE');
    await client.query('LOCK TABLE public.projection_outbox IN ACCESS EXCLUSIVE MODE');
    const populated = await client.query('SELECT EXISTS (SELECT 1 FROM public.projection_outbox) AS present');
    if (populated.rows[0].present && process.env.STATEPLANE_POPULATED_INDEX_UPGRADE !== 'drained')
      throw new Error('Populated durable outbox upgrade requires drained traffic; set STATEPLANE_POPULATED_INDEX_UPGRADE=drained only after stopping record writers, claim workers and long outbox readers');
  };
  // 045's backfill reads every source and claim identity, live or deleted,
  // and probes one extraction or revision per live identity, while evidence
  // writers wait on its locks (docs/retrieval-projections.md measures it).
  // Take its locks in its own order under the bounded wait, then require the
  // drained acknowledgement above a bound of identity rows, so the decision
  // holds through commit.
  const RETRIEVAL_BACKFILL_UNDRAINED = 10000;
  const preflightRetrievalProjections = async () => {
    await client.query(`LOCK TABLE public.collections, public.records, public.claim_revisions, public.entity_refs,
      public.extraction_versions IN SHARE ROW EXCLUSIVE MODE`);
    const identities = await client.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM public.entity_refs LIMIT $1) bounded`,
      [RETRIEVAL_BACKFILL_UNDRAINED + 1]);
    if (identities.rows[0].n > RETRIEVAL_BACKFILL_UNDRAINED && process.env.STATEPLANE_POPULATED_INDEX_UPGRADE !== 'drained')
      throw new Error(`Populated retrieval projection upgrade requires drained traffic above ${RETRIEVAL_BACKFILL_UNDRAINED} source and claim identities; set STATEPLANE_POPULATED_INDEX_UPGRADE=drained only after stopping record, source and claim writers`);
  };
  // A concurrent index build cannot run in a transaction. It takes only SHARE
  // UPDATE EXCLUSIVE, so writers and workers continue while it scans a
  // populated table; it waits for transactions already writing it and for
  // older snapshots. An interrupted build leaves an invalid index and no ledger
  // row: the next run drops it concurrently, builds again, and records the
  // file only once the index is valid. The session advisory lock keeps any
  // other migrator from building or dropping it meanwhile.
  const concurrentIndexes = new Map([['047_retrieval_outbox_age.sql', 'public.retrieval_outbox_age']]);
  const indexValid = async index => (await client.query(
    'SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)', [index])).rows[0]?.valid;
  const buildConcurrentIndex = async (name, sql, index) => {
    try {
      if (await indexValid(index) === false) await client.query(`DROP INDEX CONCURRENTLY ${index}`);
      await client.query(sql);
    } catch (error) {
      if (['55P03', '40P01', '57014'].includes(error?.code))
        throw new Error(`Concurrent index build ${name} was interrupted; retry, and the invalid index it left is rebuilt`, { cause:error });
      throw error;
    }
    if (await indexValid(index) !== true) throw new Error(`Concurrent index build ${name} left ${index} invalid; retry`);
  };
  for (const name of files) {
    const sql = await readFile(resolve(directory, name), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    if (recorded.has(name)) {
      if (recorded.get(name) !== sha256) throw new Error(`Migration drift: ${name}`);
      continue;
    }
    if (concurrentIndexes.has(name)) {
      // Commit every earlier step first; record this one in its own statement once the index is valid.
      await client.query('COMMIT');
      transactionOpen = false;
      await buildConcurrentIndex(name, sql, concurrentIndexes.get(name));
      await client.query('INSERT INTO stateplane_migrations (name, sha256) VALUES ($1, $2)', [name, sha256]);
      process.stdout.write(`Applied ${name}\n`);
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      transactionOpen = true;
      continue;
    }
    if (name === '033_validate_batch_attempts.sql' || name === '035_validate_batch_receipt_domain.sql' ||
      name === '046_retrieval_dispatch_checkpoint.sql') {
      // Release the preceding ADD CONSTRAINT schema lock before a populated
      // validation scan. The session advisory lock keeps concurrent migrators
      // serialized through this intentional, retry-safe transaction boundary.
      // 046 alters projection_outbox, which a space purge started while 045
      // applies already holds as it waits for 045's claim locks: 045 commits
      // first, so the purge finishes instead of deadlocking with 046.
      await client.query('COMMIT');
      transactionOpen = false;
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      transactionOpen = true;
    }
    // The 033/035 validation boundaries commit their preceding transaction.
    // Recheck and retain the event writer locks in the transaction that will
    // actually change the event indexes/feed, including upgrades from older ledger prefixes.
    if (pendingEventFeedUpgrade &&
      ['036_event_cursor.sql','037_commit_safe_event_feed.sql','038_drop_superseded_event_cursor.sql'].includes(name) &&
      (name === '036_event_cursor.sql' || recorded.has('036_event_cursor.sql')))
      await preflightEventFeed(); // NOSONAR -- preflight locks must precede this migration step
    const receiptDomainCutover = name === '034_batch_receipt_domain.sql' || name === '035_validate_batch_receipt_domain.sql';
    const boundedDdl = receiptDomainCutover || name === '038_drop_superseded_event_cursor.sql' ||
      name === '039_durable_outbox.sql' || name === '040_evidence_storage.sql' || name === '041_original_object_keys.sql' ||
      name === '042_claim_revision_recorder.sql' || name === '043_claim_commit_authority.sql' ||
      name === '044_links_deletion_retention.sql' || name === '045_retrieval_projections.sql' ||
      name === '046_retrieval_dispatch_checkpoint.sql';
    const priorLockTimeout = boundedDdl ? (await client.query('SHOW lock_timeout')).rows[0].lock_timeout : null; // NOSONAR -- migrations run in order within the current transaction
    if (boundedDdl) await client.query("SET LOCAL lock_timeout = '5s'"); // NOSONAR -- set before this step's DDL, never concurrently
    try {
      if (name === '039_durable_outbox.sql') await preflightDurableOutbox(); // NOSONAR -- preflight locks must precede this migration step
      if (name === '045_retrieval_projections.sql') await preflightRetrievalProjections(); // NOSONAR -- preflight locks must precede this migration step
      await client.query(sql); // NOSONAR -- ordered DDL and ledger writes form one migration transaction
    } catch (error) {
      if (receiptDomainCutover && error?.code === '55P03')
        throw new Error('Batch receipt domain upgrade requires drained traffic; stop record writers and retry', { cause:error });
      if (name === '038_drop_superseded_event_cursor.sql' && error?.code === '55P03')
        throw new Error('Event cursor index removal requires drained readers; stop long readers and retry', { cause:error });
      if (name === '039_durable_outbox.sql' && error?.code === '55P03')
        throw new Error('Durable outbox upgrade requires drained traffic; stop record writers and long outbox readers, then retry', { cause:error });
      if (name === '040_evidence_storage.sql' && error?.code === '55P03')
        throw new Error('Evidence storage upgrade waits for record writers; retry when long record transactions finish', { cause:error });
      if (name === '041_original_object_keys.sql' && error?.code === '55P03')
        throw new Error('Original object key upgrade waits for source writers; retry when long source transactions finish', { cause:error });
      if (name === '042_claim_revision_recorder.sql' && error?.code === '55P03')
        throw new Error('Claim recorder upgrade waits for claim transactions; retry when long claim transactions finish', { cause:error });
      if (name === '043_claim_commit_authority.sql' && error?.code === '55P03')
        throw new Error('Claim commit check upgrade waits for claim transactions; retry when long claim transactions finish', { cause:error });
      if (name === '044_links_deletion_retention.sql' && error?.code === '55P03')
        throw new Error('Link and retention upgrade waits for evidence writers; retry when long source or space transactions finish', { cause:error });
      // 045 locks claim revisions before identities, as revise and review do; a claim create's opposite order can
      // make PostgreSQL abort the step as a deadlock, which is retryable in the same way.
      if (name === '045_retrieval_projections.sql' && (error?.code === '55P03' || error?.code === '40P01'))
        throw new Error('Retrieval projection upgrade waits for record, extraction and claim writers; retry when long evidence transactions finish', { cause:error });
      // 046 locks projection_outbox before retrieval_outbox, as purges do; a writer holding them the other way
      // round can still make PostgreSQL abort the step as a deadlock, which rolls it back and is retryable alike.
      if (name === '046_retrieval_dispatch_checkpoint.sql' && (error?.code === '55P03' || error?.code === '40P01'))
        throw new Error('Projection outbox upgrade waits for record writers, outbox workers and space purges; retry when long record or outbox transactions finish', { cause:error });
      throw error;
    }
    if (boundedDdl) await client.query('SELECT set_config($1,$2,true)', ['lock_timeout',priorLockTimeout]); // NOSONAR -- restore this step's transaction-local timeout before the ledger write
    await client.query('INSERT INTO stateplane_migrations (name, sha256) VALUES ($1, $2)', [name, sha256]);
    process.stdout.write(`Applied ${name}\n`);
  }
  await client.query('COMMIT');
  transactionOpen = false;
} catch (error) {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (advisoryLockHeld) await client.query('SELECT pg_advisory_unlock(73003)').catch(() => {});
  await client.end().catch(() => {});
}
