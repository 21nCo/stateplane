import { Client } from 'pg';
import topology from '../topology.json' with { type: 'json' };
import { qualificationGrantsAllowed, qualificationGrantsSql } from './role-grants.js';

interface Env {
  AUTHORITY: Hyperdrive;
  PROBE_TOKEN: string;
  STATEPLANE_DISPOSABLE: string;
  STATEPLANE_PROBE_DATABASE: string;
  STATEPLANE_PROBE_ROLE: string;
}

class QualificationFailure extends Error {
  constructor(readonly stages: string[]) {
    super('Disposable qualification failed');
  }
}

async function authorized(request: Request, expected: string): Promise<boolean> {
  const supplied = request.headers.get('authorization') ?? '';
  if (!supplied.startsWith('Bearer ') || !expected) return false;
  const encode = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([encode(supplied.slice(7)), encode(expected)]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function declaredTarget(database: string | undefined, role: string | undefined): boolean {
  const match = /^sta4_([a-f0-9]{16})_(dev|prod)_([a-z]+(?:_[a-z]+)*)$/.exec(database ?? '');
  if (!match || role !== `sta4_probe_${match[1]}`) return false;
  const environment = match[2] === 'dev' ? topology.environments.development : topology.environments.production;
  return environment.cells.some(cell => cell.id.replaceAll('-', '_') === match[3]);
}

type ProbeClient = Client;

async function atStage<T>(stage: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new QualificationFailure([`probe:${stage}`]); }
}

async function verifyTarget(writer: ProbeClient, database: string, role: string): Promise<string> {
  await atStage('target-identity', async () => {
    const identity = await writer.query('SELECT current_database() AS database, current_user AS role');
    if (identity.rows[0]?.database !== database || identity.rows[0]?.role !== role) throw new Error('Target identity mismatch');
  });
  await atStage('target-grants', async () => {
    const grants = await writer.query(qualificationGrantsSql);
    if (grants.rows.length !== 1 || !qualificationGrantsAllowed(grants.rows[0])) throw new Error('Target grants unavailable or excessive');
  });
  const extension = await atStage('pgvector-extension', async () => {
    const response = await writer.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    if (typeof response.rows[0]?.extversion !== 'string' || !response.rows[0].extversion) throw new Error('pgvector missing');
    return response.rows[0].extversion as string;
  });
  await atStage('pgvector-distance', async () => {
    const vector = await writer.query("SELECT '[1,0,0]'::vector <-> '[0,1,0]'::vector AS distance");
    const distance: unknown = vector.rows[0]?.distance;
    if (typeof distance !== 'number' || !Number.isFinite(distance) || Math.abs(distance - Math.sqrt(2)) > 0.00001) throw new Error('pgvector distance mismatch');
  });
  return extension;
}

async function verifyRollback(writer: ProbeClient, id: string, markRow: () => void): Promise<void> {
  await atStage('transaction-begin', () => writer.query('BEGIN'));
  const failures: string[] = [];
  try {
    await atStage('transaction-insert', async () => {
      await writer.query('SET LOCAL statement_timeout = 5000');
      markRow();
      await writer.query('INSERT INTO stateplane_qualification (probe_id, value) VALUES ($1, 99)', [id]);
    });
  } catch (error) { failures.push(...(error as QualificationFailure).stages); }
  try { await atStage('transaction-rollback', () => writer.query('ROLLBACK')); }
  catch (error) { failures.push(...(error as QualificationFailure).stages); }
  if (failures.length) throw new QualificationFailure(failures);
  await atStage('rollback-read', async () => {
    const rolledBack = await writer.query('SELECT count(*)::integer AS count FROM stateplane_qualification WHERE probe_id = $1', [id]);
    if (rolledBack.rows[0]?.count !== 0) throw new Error('Rollback was not atomic');
  });
}

async function verifyFreshReads(writer: ProbeClient, reader: ProbeClient, id: string): Promise<{ observedConnections: number; maxConnections: number; reservedConnections: number }> {
  await atStage('reader-connect', () => reader.connect());
  await atStage('initial-read', async () => {
    const first = await reader.query('SELECT value FROM stateplane_qualification WHERE probe_id = $1', [id]);
    if (first.rows[0]?.value !== 1) throw new Error('Initial read was stale');
  });
  await atStage('committed-update', () => writer.query('UPDATE stateplane_qualification SET value = 2 WHERE probe_id = $1', [id]));
  await atStage('fresh-read', async () => {
    const fresh = await reader.query('SELECT value FROM stateplane_qualification WHERE probe_id = $1', [id]);
    if (fresh.rows[0]?.value !== 2) throw new Error('Fresh read was stale');
  });
  return atStage('connection-budget', async () => {
    // pg_stat_activity exposes rows for other roles/databases even without permission to read their query text.
    // Count every client backend sharing this Postgres server, including the qualification clients.
    const activity = await reader.query("SELECT count(*) FILTER (WHERE backend_type = 'client backend')::integer AS count, current_setting('max_connections')::integer AS max_connections, (current_setting('superuser_reserved_connections')::integer + COALESCE(current_setting('reserved_connections', true)::integer, 0)) AS reserved_connections FROM pg_stat_activity");
    const count: unknown = activity.rows[0]?.count;
    const max: unknown = activity.rows[0]?.max_connections;
    const reserved: unknown = activity.rows[0]?.reserved_connections;
    if (!Number.isSafeInteger(count) || (count as number) < 2 || !Number.isSafeInteger(max) ||
        !Number.isSafeInteger(reserved) || (reserved as number) < 0 ||
        (max as number) - (reserved as number) < (count as number)) throw new Error('Connection budget unavailable');
    return { observedConnections: count as number, maxConnections: max as number, reservedConnections: reserved as number };
  });
}

async function cleanupRow(writer: ProbeClient, id: string): Promise<void> {
  try { await writer.query('DELETE FROM stateplane_qualification WHERE probe_id = $1', [id]); }
  catch { throw new QualificationFailure(['cleanup-delete']); }
  try {
    const remaining = await writer.query('SELECT count(*)::integer AS count FROM stateplane_qualification WHERE probe_id = $1', [id]);
    if (remaining.rows[0]?.count !== 0) throw new Error('Qualification row cleanup failed');
  } catch { throw new QualificationFailure(['cleanup-verify']); }
}

async function probe(connectionString: string, expectedDatabase: string, expectedRole: string) {
  const id = crypto.randomUUID();
  const writer = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const reader = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const start = Date.now();
  let rowMayExist = false;
  let result: { pgvectorVersion: string; rollback: boolean; freshRead: boolean; observedConnections: number; maxConnections: number; reservedConnections: number; elapsedMs: number } | undefined;
  const failures: string[] = [];
  try {
    await atStage('writer-connect', () => writer.connect());
    const pgvectorVersion = await verifyTarget(writer, expectedDatabase, expectedRole);
    await atStage('probe-table', () => writer.query('CREATE TABLE IF NOT EXISTS stateplane_qualification (probe_id uuid PRIMARY KEY, value integer NOT NULL)'));
    await verifyRollback(writer, id, () => { rowMayExist = true; });
    await atStage('committed-insert', () => writer.query('INSERT INTO stateplane_qualification (probe_id, value) VALUES ($1, 1)', [id]));
    const { observedConnections, maxConnections, reservedConnections } = await verifyFreshReads(writer, reader, id);
    result = { pgvectorVersion, rollback: true, freshRead: true, observedConnections, maxConnections, reservedConnections, elapsedMs: Date.now() - start };
  } catch (error) {
    failures.push(...(error instanceof QualificationFailure ? error.stages : ['probe:unexpected']));
  }
  if (rowMayExist) {
    try { await cleanupRow(writer, id); }
    catch (error) { failures.push(...(error as QualificationFailure).stages); }
  }
  const closed = await Promise.allSettled([writer.end(), reader.end()]);
  if (closed[0].status === 'rejected') failures.push('close:writer');
  if (closed[1].status === 'rejected') failures.push('close:reader');
  if (failures.length) throw new QualificationFailure(failures);
  if (!result) throw new Error('Qualification result missing');
  return result;
}

async function verifyNoResiduals(connectionString: string, expectedDatabase: string, expectedRole: string) {
  const reader = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const failures: string[] = [];
  try {
    await atStage('reader-connect', () => reader.connect());
    await verifyTarget(reader, expectedDatabase, expectedRole);
    await atStage('residual-read', async () => {
      const rows = await reader.query('SELECT count(*)::integer AS count FROM stateplane_qualification');
      if (rows.rows[0]?.count !== 0) throw new Error('Qualification rows remain');
    });
  } catch (error) {
    failures.push(...(error instanceof QualificationFailure ? error.stages : ['probe:unexpected']));
  }
  try { await reader.end(); }
  catch { failures.push('close:reader'); }
  if (failures.length) throw new QualificationFailure(failures);
  return { residualRows: 0 };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!['/qualify', '/qualify/residual'].includes(path) || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (env.STATEPLANE_DISPOSABLE !== '1' || !declaredTarget(env.STATEPLANE_PROBE_DATABASE, env.STATEPLANE_PROBE_ROLE) ||
        !env.AUTHORITY?.connectionString || !(await authorized(request, env.PROBE_TOKEN))) return new Response('Forbidden', { status: 403 });
    try {
      const result = path === '/qualify'
        ? await probe(env.AUTHORITY.connectionString, env.STATEPLANE_PROBE_DATABASE, env.STATEPLANE_PROBE_ROLE)
        : await verifyNoResiduals(env.AUTHORITY.connectionString, env.STATEPLANE_PROBE_DATABASE, env.STATEPLANE_PROBE_ROLE);
      return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      console.error('Qualification failed', error instanceof QualificationFailure ? error.stages.join(',') : 'unexpected');
      return Response.json({ ok: false }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
  }
} satisfies ExportedHandler<Env>;
