import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';

// Run after migration 045 or restore through a protected cell administration
// connection. The role is supplied by the protected deployment inventory.
// Space deletion proves erasure by reading every retrieval table. Policy
// writers insert retrieval policy versions; the projection worker (STA-45 and
// later) starts and moves generations, advances projected Refs, replaces
// chunks and checkpoints, records deletion receipts and delivers retrieval
// work. Migration 045's owner-rights triggers enqueue that work, so the role
// needs no insert on it. Projected Refs, receipts, generations and work are
// never deletable: removal stays with the scoped purge routine. Chunks and
// checkpoints are derived and replaced by deleting them.
// An HNSW index casts each embedding to its dimension on insert, and
// PostgreSQL checks EXECUTE on that cast function for the inserting role, so
// the role is granted it explicitly where PUBLIC execution was revoked.
const url=process.env.STATEPLANE_CELL_ADMIN_URL;
const role=process.env.STATEPLANE_CELL_ROLE;
if (!url || !role || !/^(?!pg_)[a-z][a-z0-9_]{0,62}$/.test(role))
  throw new Error('Set STATEPLANE_CELL_ADMIN_URL and a valid STATEPLANE_CELL_ROLE');

const grants=[
  ['retrieval_policies','SELECT, INSERT'],
  ['vector_index_strategies','SELECT'],
  ['projection_generations','SELECT, INSERT, UPDATE'],
  ['projection_refs','SELECT, INSERT, UPDATE'],
  ['projection_deletion_receipts','SELECT, INSERT'],
  ['lexical_chunks','SELECT, INSERT, DELETE'],
  ['vector_chunks','SELECT, INSERT, DELETE'],
  ['embedding_checkpoints','SELECT, INSERT, DELETE'],
  ['retrieval_outbox','SELECT, UPDATE']
];
const routines=['public.vector(public.vector, integer, boolean)'];
const client=new pg.Client(connectionOptions(url));
await client.connect();
try {
  const found=await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
  if (found.rowCount!==1) throw new Error('Cell operational role does not exist');
  await client.query('BEGIN');
  for (const [table,privileges] of grants) await client.query(`GRANT ${privileges} ON TABLE public.${table} TO "${role}"`);
  for (const routine of routines) await client.query(`GRANT EXECUTE ON FUNCTION ${routine} TO "${role}"`);
  // A comma-separated privilege list is true when any one is held; check each.
  for (const [table,privileges] of grants) for (const privilege of privileges.split(', ')) {
    const checked=await client.query('SELECT has_table_privilege($1,$2,$3) AS granted',[role,`public.${table}`,privilege]);
    if (checked.rows[0].granted!==true) throw new Error(`Retrieval grant unavailable: ${privilege} on ${table}`);
  }
  for (const routine of routines) {
    const checked=await client.query(`SELECT has_function_privilege($1,$2,'EXECUTE') AS granted`,[role,routine]);
    if (checked.rows[0].granted!==true) throw new Error(`Retrieval grant unavailable: EXECUTE on ${routine}`);
  }
  await client.query('COMMIT');
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
} finally { await client.end(); }
process.stdout.write('Retrieval grants verified\n');
