import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';

// Run after migration 052 or restore through a protected cell administration
// connection. The role is supplied by the protected deployment inventory.
// Space deletion proves erasure by reading every analysis table. Analysis
// workers (STA-58 and later) admit and advance jobs, write result pages and
// manifests, remove the results of cancelled, failed or expired jobs (an
// expired one's through its removal queue, migration 052), and add,
// take and release concurrency slots. No grant allows deleting a job or a
// slot, or TRUNCATE: removal stays with the scoped purge routine, and ending a
// job releases its slots through an owner-rights trigger.
const url=process.env.STATEPLANE_CELL_ADMIN_URL;
const role=process.env.STATEPLANE_CELL_ROLE;
if (!url || !role || !/^(?!pg_)[a-z][a-z0-9_]{0,62}$/.test(role))
  throw new Error('Set STATEPLANE_CELL_ADMIN_URL and a valid STATEPLANE_CELL_ROLE');

const grants=[
  ['analysis_jobs','SELECT, INSERT, UPDATE'],
  ['analysis_result_pages','SELECT, INSERT, DELETE'],
  ['analysis_result_manifests','SELECT, INSERT, DELETE'],
  ['analysis_space_slots','SELECT, INSERT, UPDATE'],
  ['analysis_cell_slots','SELECT, INSERT, UPDATE'],
  ['analysis_removals','SELECT, UPDATE, DELETE']
];
const client=new pg.Client(connectionOptions(url));
await client.connect();
try {
  const found=await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
  if (found.rowCount!==1) throw new Error('Cell operational role does not exist');
  await client.query('BEGIN');
  await client.query(grants.map(([table,privileges])=>`GRANT ${privileges} ON TABLE public.${table} TO "${role}"`).join(';\n'));
  // A comma-separated privilege list is true when any one is held; check each.
  const wanted=grants.flatMap(([table,privileges])=>privileges.split(', ').map(privilege=>[`public.${table}`,privilege]));
  const missing=await client.query(`SELECT 'Analysis grant unavailable: '||p||' on '||t AS problem
    FROM unnest($2::text[],$3::text[]) AS w(t,p) WHERE NOT has_table_privilege($1,t,p)`,
  [role,wanted.map(([table])=>table),wanted.map(([,privilege])=>privilege)]);
  if (missing.rowCount) throw new Error(missing.rows.map(row=>row.problem).join('; '));
  await client.query('COMMIT');
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
} finally { await client.end(); }
process.stdout.write('Analysis grants verified\n');
