import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';

// Run after migration 052 or restore through a protected cell administration
// connection. The role is supplied by the protected deployment inventory.
// Space deletion proves erasure by reading every portability table. Export
// and import workers (STA-70 and STA-71) admit and advance jobs, write parts,
// remove the parts of cancelled, failed or expired exports through their
// removal queue, and write and
// complete principal mappings. No grant allows deleting a job or a mapping,
// or TRUNCATE: removal stays with the scoped purge routine.
const url=process.env.STATEPLANE_CELL_ADMIN_URL;
const role=process.env.STATEPLANE_CELL_ROLE;
if (!url || !role || !/^(?!pg_)[a-z][a-z0-9_]{0,62}$/.test(role))
  throw new Error('Set STATEPLANE_CELL_ADMIN_URL and a valid STATEPLANE_CELL_ROLE');

const grants=[
  ['portability_jobs','SELECT, INSERT, UPDATE'],
  ['portability_parts','SELECT, INSERT, DELETE'],
  ['portability_principal_map','SELECT, INSERT, UPDATE'],
  // The shared snapshot step records whose turn is next, and clears ended exports' parts through their removal queue,
  // which a trigger fills (migration 052).
  ['snapshot_step_turn','SELECT, UPDATE'],
  ['portability_removals','SELECT, UPDATE, DELETE']
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
  const missing=await client.query(`SELECT 'Portability grant unavailable: '||p||' on '||t AS problem
    FROM unnest($2::text[],$3::text[]) AS w(t,p) WHERE NOT has_table_privilege($1,t,p)`,
  [role,wanted.map(([table])=>table),wanted.map(([,privilege])=>privilege)]);
  if (missing.rowCount) throw new Error(missing.rows.map(row=>row.problem).join('; '));
  await client.query('COMMIT');
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
} finally { await client.end(); }
process.stdout.write('Portability grants verified\n');
