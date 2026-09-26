import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://stateplane:local-only-stateplane@127.0.0.1:55432/stateplane';
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
const directory = resolve(import.meta.dirname, '../migrations');
let transactionOpen = false;
try {
  await client.connect();
  await client.query('BEGIN');
  transactionOpen = true;
  await client.query('SELECT pg_advisory_xact_lock(73003)');
  await client.query('CREATE TABLE IF NOT EXISTS stateplane_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const name of files) {
    const sql = await readFile(resolve(directory, name), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    const found = await client.query('SELECT sha256 FROM stateplane_migrations WHERE name = $1', [name]);
    if (found.rows.length) {
      if (found.rows[0].sha256 !== sha256) throw new Error(`Migration drift: ${name}`);
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
