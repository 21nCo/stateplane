import { parseArgs } from 'node:util';
import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';
import { reconcileIndexes, reconciliationBounds } from '../packages/postgres/dist/index.js';

// Operator check (STA-60, docs/analysis-measurements.md#reconciliation): compare one collection's typed index rows with
// what its records' canonical data derive, read-only, through DATABASE_URL (a cell connection that can read records,
// record_index_values, collections, collection_versions and collection_index_declarations). Prints the report as JSON:
// drift by record, field and kind, never values. Without --max-records it reads the collection (after --after) to its end;
// with it, at most that many records. Exits 0 when everything it was to read was read and no drift was found, 2 when any
// drift was found, 3 when a --max-records bound ended it before the collection's end with no drift (continue with --after
// set to the report's next), and 1 when the check itself failed (no report).
const { values } = parseArgs({ options: { space: { type: 'string' }, collection: { type: 'string' }, after: { type: 'string' },
  'max-records': { type: 'string' } } });
if (!values.space || !values.collection)
  throw new Error('Usage: node scripts/reconcile-indexes.mjs --space ID --collection ID [--after RECORD_ID] [--max-records N]');
const bounded = values['max-records'] !== undefined;
const maxRecords = bounded ? Number(values['max-records']) : reconciliationBounds.maxRecords;
const pool = new pg.Pool({ ...connectionOptions(process.env.DATABASE_URL), max: 1 });
try {
  let report = await reconcileIndexes(pool, values.space, values.collection, { after: values.after ?? null, maxRecords });
  // Unbounded: continue each call where the last ended, as one report (fields every call checked, the first samples).
  while (!bounded && report.next !== null) {
    const more = await reconcileIndexes(pool, values.space, values.collection, { after: report.next, maxRecords });
    report = { ...report, fields: report.fields.filter(field => more.fields.includes(field)), checked: report.checked + more.checked,
      next: more.next, driftCount: report.driftCount + more.driftCount,
      drift: [...report.drift, ...more.drift].slice(0, reconciliationBounds.samples) };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.driftCount) process.exitCode = 2;
  else if (report.next !== null) process.exitCode = 3;
} finally { await pool.end(); }
