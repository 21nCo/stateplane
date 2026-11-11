import { parseArgs } from 'node:util';
import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';
import { reconcileIndexes } from '../packages/postgres/dist/index.js';

// Operator check (STA-60, docs/analysis-measurements.md#reconciliation): compare one collection's typed index rows with
// what its records' canonical data derive, read-only, through DATABASE_URL (a cell connection that can read records,
// record_index_values, collections, collection_versions and collection_index_declarations). Prints the report as JSON:
// drift by record, field and kind, never values. Exits 0 when no drift is found, 2 when any is (the report is complete), and 1
// when the check itself failed (no report); continue a bounded run with --after.
const { values } = parseArgs({ options: { space: { type: 'string' }, collection: { type: 'string' }, after: { type: 'string' },
  'max-records': { type: 'string' } } });
if (!values.space || !values.collection)
  throw new Error('Usage: node scripts/reconcile-indexes.mjs --space ID --collection ID [--after RECORD_ID] [--max-records N]');
const pool = new pg.Pool({ ...connectionOptions(process.env.DATABASE_URL), max: 1 });
try {
  const report = await reconcileIndexes(pool, values.space, values.collection, { after: values.after ?? null,
    ...(values['max-records'] === undefined ? {} : { maxRecords: Number(values['max-records']) }) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.driftCount) process.exitCode = 2;
} finally { await pool.end(); }
