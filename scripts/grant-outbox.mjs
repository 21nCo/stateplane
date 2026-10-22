import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';

// Run after migration 039 or restore through a protected cell administration
// connection. The role is supplied by the protected deployment inventory.
const url=process.env.STATEPLANE_CELL_ADMIN_URL;
const role=process.env.STATEPLANE_CELL_ROLE;
if (!url || !role || !/^(?!pg_)[a-z][a-z0-9_]{0,62}$/.test(role))
  throw new Error('Set STATEPLANE_CELL_ADMIN_URL and a valid STATEPLANE_CELL_ROLE');

const grants=[
  ['projection_heads','SELECT, INSERT, UPDATE'],
  ['outbox_dispatch_checkpoint','SELECT, UPDATE'],
  ['projection_reconciliations','SELECT, INSERT, UPDATE'],
  ['outbox_operator_audit','SELECT, INSERT']
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
    if (checked.rows[0].granted!==true) throw new Error(`Outbox grant unavailable: ${privilege} on ${table}`);
  }
  await client.query('COMMIT');
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
} finally { await client.end(); }
process.stdout.write('Outbox operational grants verified\n');
