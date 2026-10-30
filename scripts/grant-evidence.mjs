import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';

// Run after migration 040 or restore through a protected cell administration
// connection. The role is supplied by the protected deployment inventory.
// Space deletion proves erasure by reading every evidence table. Source
// ingestion, upload grants and upload reconciliation (STA-33) insert sources
// and originals and advance the upload ledger; later evidence writes get
// their grants with the service slices that perform them. No grant allows
// DELETE or TRUNCATE: removal stays with the scoped purge routine.
const url=process.env.STATEPLANE_CELL_ADMIN_URL;
const role=process.env.STATEPLANE_CELL_ROLE;
if (!url || !role || !/^(?!pg_)[a-z][a-z0-9_]{0,62}$/.test(role))
  throw new Error('Set STATEPLANE_CELL_ADMIN_URL and a valid STATEPLANE_CELL_ROLE');

const grants=[
  ['sources','SELECT, INSERT'],
  ['original_objects','SELECT, INSERT'],
  ['source_upload_grants','SELECT, INSERT, UPDATE'],
  ['source_upload_attempts','SELECT, INSERT, UPDATE'],
  ['extraction_versions','SELECT'],
  ['claims','SELECT'],
  ['claim_revisions','SELECT'],
  ['claim_evidence','SELECT'],
  ['links','SELECT']
];
const client=new pg.Client(connectionOptions(url));
await client.connect();
try {
  const found=await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
  if (found.rowCount!==1) throw new Error('Cell operational role does not exist');
  await client.query('BEGIN');
  for (const [table,privileges] of grants) await client.query(`GRANT ${privileges} ON TABLE public.${table} TO "${role}"`);
  // A comma-separated privilege list is true when any one is held; check each.
  for (const [table,privileges] of grants) for (const privilege of privileges.split(', ')) {
    const checked=await client.query('SELECT has_table_privilege($1,$2,$3) AS granted',[role,`public.${table}`,privilege]);
    if (checked.rows[0].granted!==true) throw new Error(`Evidence grant unavailable: ${privilege} on ${table}`);
  }
  await client.query('COMMIT');
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
} finally { await client.end(); }
process.stdout.write('Evidence grants verified\n');
