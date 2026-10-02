import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';
import { migrationInventory, migrationOrder } from './migration-order.mjs';

const client = new pg.Client(connectionOptions(process.env.DATABASE_URL));
const directory = resolve(import.meta.dirname, '../migrations');
let transactionOpen = false;
try {
  await client.connect();
  await client.query('BEGIN');
  transactionOpen = true;
  await client.query('SELECT pg_advisory_xact_lock(73003)');
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
  for (const name of files) {
    const sql = await readFile(resolve(directory, name), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    if (recorded.has(name)) {
      if (recorded.get(name) !== sha256) throw new Error(`Migration drift: ${name}`);
      continue;
    }
    await client.query(sql);
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
  await client.end().catch(() => {});
}
