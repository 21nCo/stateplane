import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';

// Run after migrations 045 and 046 or restore through a protected cell
// administration connection. The role is supplied by the protected
// deployment inventory. Space deletion proves erasure by reading every
// space-scoped retrieval table (the collection heads are written only by
// owner-rights triggers). Policy writers insert retrieval policy versions;
// the projection worker (STA-45 and later) starts and moves generations,
// advances projected Refs, replaces chunks and checkpoints, records deletion
// receipts, delivers retrieval work and moves its claim cursor (046).
// Migration 045's owner-rights triggers enqueue that work, so the role needs
// no insert on it. Projected Refs, receipts, generations and work are never
// deletable: removal stays with the scoped purge routine. Chunks and
// checkpoints are derived and replaced by deleting them.
// An HNSW index casts each embedding to its dimension on insert, and
// PostgreSQL checks EXECUTE on that cast function for the inserting role, so
// the role is granted it explicitly where PUBLIC execution was revoked.
// Search (STA-46) ranks vector candidates by cosine distance (`<=>`), whose
// backing function needs the same explicit EXECUTE grant.
const url=process.env.STATEPLANE_CELL_ADMIN_URL;
const role=process.env.STATEPLANE_CELL_ROLE;
if (!url || !role || !/^(?!pg_)[a-z][a-z0-9_]{0,62}$/.test(role))
  throw new Error('Set STATEPLANE_CELL_ADMIN_URL and a valid STATEPLANE_CELL_ROLE');

const grants=[
  ['retrieval_policies','SELECT, INSERT'],
  ['retrieval_collection_heads','SELECT'],
  ['vector_index_strategies','SELECT'],
  ['projection_generations','SELECT, INSERT, UPDATE'],
  ['projection_refs','SELECT, INSERT, UPDATE'],
  ['projection_deletion_receipts','SELECT, INSERT'],
  ['lexical_chunks','SELECT, INSERT, DELETE'],
  ['vector_chunks','SELECT, INSERT, DELETE'],
  ['embedding_checkpoints','SELECT, INSERT, DELETE'],
  ['retrieval_outbox','SELECT, UPDATE'],
  ['retrieval_dispatch_checkpoint','SELECT, UPDATE']
];
const routines=['public.vector(public.vector, integer, boolean)','public.cosine_distance(public.vector, public.vector)'];
const client=new pg.Client(connectionOptions(url));
await client.connect();
try {
  const found=await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
  if (found.rowCount!==1) throw new Error('Cell operational role does not exist');
  await client.query('BEGIN');
  // One batch of statements, applied in order inside this transaction.
  await client.query([...grants.map(([table,privileges])=>`GRANT ${privileges} ON TABLE public.${table} TO "${role}"`),
    ...routines.map(routine=>`GRANT EXECUTE ON FUNCTION ${routine} TO "${role}"`)].join(';\n'));
  // A comma-separated privilege list is true when any one is held; check each.
  const wanted=grants.flatMap(([table,privileges])=>privileges.split(', ').map(privilege=>[`public.${table}`,privilege]));
  const missing=await client.query(`SELECT 'Retrieval grant unavailable: '||p||' on '||t AS problem
    FROM unnest($2::text[],$3::text[]) AS w(t,p) WHERE NOT has_table_privilege($1,t,p)
    UNION ALL SELECT 'Retrieval grant unavailable: EXECUTE on '||r FROM unnest($4::text[]) AS r
    WHERE NOT has_function_privilege($1,r,'EXECUTE')`,[role,wanted.map(([table])=>table),wanted.map(([,privilege])=>privilege),routines]);
  if (missing.rowCount) throw new Error(missing.rows.map(row=>row.problem).join('; '));
  await client.query('COMMIT');
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
} finally { await client.end(); }
process.stdout.write('Retrieval grants verified\n');
