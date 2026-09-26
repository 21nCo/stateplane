import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';
import { migrationOrder } from './migration-order.mjs';

const client = new pg.Client(connectionOptions(process.env.DATABASE_URL));
const directory = resolve(import.meta.dirname, '../migrations');
let transactionOpen = false;
try {
  await client.connect();
  await client.query('BEGIN');
  transactionOpen = true;
  await client.query('SELECT pg_advisory_xact_lock(73003)');
  await client.query('CREATE TABLE IF NOT EXISTS stateplane_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort(migrationOrder);
  const applied = await client.query('SELECT name, sha256 FROM stateplane_migrations');
  const recorded = new Map(applied.rows.map(row => [row.name, row.sha256]));
  const recordedNames = [...recorded.keys()].sort(migrationOrder);
  for (const [index, name] of recordedNames.entries()) {
    if (files[index] !== name) throw new Error(`Migration drift: applied history is not a prefix of current files at ${name}`);
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
