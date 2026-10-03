import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';

// Run through the direct migration connection after migration and restore.
// The role comes from the protected control inventory, never a request.
const url=process.env.STATEPLANE_CONTROL_URL;
const role=process.env.STATEPLANE_CONTROL_ROLE;
if (!url || !role || !/^(?!pg_)[a-z][a-z0-9_]{0,62}$/.test(role))
  throw new Error('Set STATEPLANE_CONTROL_URL and a valid STATEPLANE_CONTROL_ROLE');
const client=new pg.Client(connectionOptions(url));
await client.connect();
try {
  await client.query('BEGIN');
  const found=await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
  if (found.rowCount!==1) throw new Error('Control operational role does not exist');
  await client.query(`GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_key_issuances TO "${role}"`);
  const grants=await client.query(`SELECT has_table_privilege($1,'public.agent_key_issuances','SELECT') AS can_read,
    has_table_privilege($1,'public.agent_key_issuances','INSERT') AS can_create,
    has_table_privilege($1,'public.agent_key_issuances','UPDATE') AS can_update`,[role]);
  if (!Object.values(grants.rows[0]).every(value=>value===true)) throw new Error('Control journal grant readback failed');
  await client.query('COMMIT');
  console.log('Verified control journal SELECT, INSERT and UPDATE grants');
} catch (error) {
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
} finally { await client.end(); }
