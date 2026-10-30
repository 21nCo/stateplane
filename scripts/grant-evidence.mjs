import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';

// Run after migration 040 or restore through a protected cell administration
// connection. The role is supplied by the protected deployment inventory.
// Space deletion proves erasure by reading these tables; evidence writes and
// reads get their own grants with the service slices that perform them.
const url=process.env.STATEPLANE_CELL_ADMIN_URL;
const role=process.env.STATEPLANE_CELL_ROLE;
if (!url || !role || !/^(?!pg_)[a-z][a-z0-9_]{0,62}$/.test(role))
  throw new Error('Set STATEPLANE_CELL_ADMIN_URL and a valid STATEPLANE_CELL_ROLE');

const tables=['sources','original_objects','source_upload_grants','source_upload_attempts','extraction_versions',
  'claims','claim_revisions','claim_evidence','links'];
const client=new pg.Client(connectionOptions(url));
await client.connect();
try {
  const found=await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
  if (found.rowCount!==1) throw new Error('Cell operational role does not exist');
  await client.query('BEGIN');
  for (const table of tables) await client.query(`GRANT SELECT ON TABLE public.${table} TO "${role}"`);
  for (const table of tables) {
    const checked=await client.query('SELECT has_table_privilege($1,$2,$3) AS granted',[role,`public.${table}`,'SELECT']);
    if (checked.rows[0].granted!==true) throw new Error(`Evidence grant unavailable: SELECT on ${table}`);
  }
  await client.query('COMMIT');
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
} finally { await client.end(); }
process.stdout.write('Evidence erasure grants verified\n');
