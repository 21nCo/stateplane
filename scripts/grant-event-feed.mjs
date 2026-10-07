import pg from 'pg';

// Run after migration or restore through a protected cell administration
// connection. The role is supplied by the protected deployment inventory.
const url=process.env.STATEPLANE_CELL_ADMIN_URL;
const role=process.env.STATEPLANE_CELL_ROLE;
if (!url || !role || !/^(?!pg_)[a-z][a-z0-9_]{0,62}$/.test(role))
  throw new Error('Set STATEPLANE_CELL_ADMIN_URL and a valid STATEPLANE_CELL_ROLE');

const client=new pg.Client({connectionString:url});
await client.connect();
try {
  const found=await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
  if (found.rowCount!==1) throw new Error('Cell operational role does not exist');
  await client.query('BEGIN');
  await client.query(`GRANT SELECT, INSERT ON TABLE public.record_event_feed TO "${role}"`);
  await client.query(`GRANT SELECT, INSERT, DELETE ON TABLE public.record_event_pending TO "${role}"`);
  await client.query(`GRANT USAGE ON SEQUENCE public.record_event_feed_position_seq TO "${role}"`);
  await client.query(`GRANT EXECUTE ON FUNCTION public.stateplane_queue_record_event() TO "${role}"`);
  const privileges=await client.query(`SELECT
    has_table_privilege($1,'public.record_event_feed','SELECT,INSERT') AS feed,
    has_table_privilege($1,'public.record_event_pending','SELECT,INSERT,DELETE') AS pending,
    has_sequence_privilege($1,'public.record_event_feed_position_seq','USAGE') AS sequence,
    has_function_privilege($1,'public.stateplane_queue_record_event()','EXECUTE') AS trigger`,[role]);
  if (Object.values(privileges.rows[0]).some(value=>value!==true)) throw new Error('Event feed grants unavailable');
  await client.query('COMMIT');
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
} finally { await client.end(); }
process.stdout.write('Event feed operational grants verified\n');
