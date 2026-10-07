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
  await client.query('SELECT pg_advisory_lock(73003)');
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
  for (const name of files) {
    const sql = await readFile(resolve(directory, name), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    if (recorded.has(name)) {
      if (recorded.get(name) !== sha256) throw new Error(`Migration drift: ${name}`);
      continue;
    }
    if (name === '033_validate_batch_attempts.sql' || name === '035_validate_batch_receipt_domain.sql') {
      // Release the preceding ADD CONSTRAINT schema lock before a populated
      // validation scan. The session advisory lock keeps concurrent migrators
      // serialized through this intentional, retry-safe transaction boundary.
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
    const boundedDdl = receiptDomainCutover || name === '038_drop_superseded_event_cursor.sql';
    const priorLockTimeout = boundedDdl ? (await client.query('SHOW lock_timeout')).rows[0].lock_timeout : null;
    if (boundedDdl) await client.query("SET LOCAL lock_timeout = '5s'");
    try { await client.query(sql); }
    catch (error) {
      if (receiptDomainCutover && error?.code === '55P03')
        throw new Error('Batch receipt domain upgrade requires drained traffic; stop record writers and retry', { cause:error });
      if (name === '038_drop_superseded_event_cursor.sql' && error?.code === '55P03')
        throw new Error('Event cursor index removal requires drained readers; stop long readers and retry', { cause:error });
      throw error;
    }
    if (boundedDdl) await client.query('SELECT set_config($1,$2,true)', ['lock_timeout',priorLockTimeout]);
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
