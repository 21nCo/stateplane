import { Client } from 'pg';
import topology from '../topology.json' with { type: 'json' };
import { qualificationGrantsAllowed, qualificationGrantsSql } from './role-grants.js';
import { probeRelationAllowed, probeRelationsSql } from './probe-relations.js';

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
const attemptPattern = /^[1-9]\d{0,18}$/;

async function verifyProbeRelations(client: ProbeClient, required: boolean): Promise<void> {
  await atStage('probe-relations', async () => {
    const result = await client.query(`SELECT current_user AS current_role, probe.* FROM (${probeRelationsSql}) AS probe`);
    const names = new Set(result.rows.map(row => row.relname));
    if (result.rows.some(row => !probeRelationAllowed(row)) ||
      (required && (names.size !== 2 || result.rows.length !== 2))) throw new Error('Probe relation contract mismatch');
  });
}

async function lockProbeRelations(client: ProbeClient): Promise<void> {
  await atStage('probe-relations-lock', () => client.query(
    'LOCK TABLE public.stateplane_qualification, public.stateplane_qualification_attempt IN ACCESS SHARE MODE'));
  await verifyProbeRelations(client, true);
}

async function attemptTransaction<T>(client: ProbeClient, work: () => Promise<T>): Promise<T> {
  await atStage('attempt-begin', () => client.query('BEGIN'));
  try {
    await atStage('attempt-timeout', () => client.query("SET LOCAL lock_timeout = '5000ms'"));
    const result = await work();
    await atStage('attempt-commit', () => client.query('COMMIT'));
    return result;
  } catch (error) {
    const stages = error instanceof QualificationFailure ? error.stages : ['probe:unexpected'];
    try { await client.query('ROLLBACK'); }
    catch { stages.push('attempt:rollback'); }
    throw new QualificationFailure(stages);
  }
}

async function atStage<T>(stage: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new QualificationFailure([`probe:${stage}`]); }
}

async function verifyTarget(writer: ProbeClient, database: string, role: string, requireRelations = true): Promise<string> {
  await atStage('target-identity', async () => {
    const identity = await writer.query('SELECT current_database() AS database, current_user AS role');
    if (identity.rows[0]?.database !== database || identity.rows[0]?.role !== role) throw new Error('Target identity mismatch');
  });
  await atStage('target-grants', async () => {
    const grants = await writer.query(qualificationGrantsSql);
    if (grants.rows.length !== 1 || !qualificationGrantsAllowed(grants.rows[0])) throw new Error('Target grants unavailable or excessive');
  });
  await verifyProbeRelations(writer, requireRelations);
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
      await writer.query('INSERT INTO public.stateplane_qualification (probe_id, value) VALUES ($1, 99)', [id]);
    });
  } catch (error) { failures.push(...(error as QualificationFailure).stages); }
  try { await atStage('transaction-rollback', () => writer.query('ROLLBACK')); }
  catch (error) { failures.push(...(error as QualificationFailure).stages); }
  if (failures.length) throw new QualificationFailure(failures);
  await atStage('rollback-read', async () => {
    const rolledBack = await writer.query('SELECT count(*)::integer AS count FROM public.stateplane_qualification WHERE probe_id = $1', [id]);
    if (rolledBack.rows[0]?.count !== 0) throw new Error('Rollback was not atomic');
  });
}

async function verifyFreshReads(writer: ProbeClient, reader: ProbeClient, id: string): Promise<{ observedConnections: number; maxConnections: number; reservedConnections: number }> {
  await atStage('initial-read', async () => {
    const first = await reader.query('SELECT value FROM public.stateplane_qualification WHERE probe_id = $1', [id]);
    if (first.rows[0]?.value !== 1) throw new Error('Initial read was stale');
  });
  await atStage('committed-update', () => writer.query('UPDATE public.stateplane_qualification SET value = 2 WHERE probe_id = $1', [id]));
  await atStage('fresh-read', async () => {
    const fresh = await reader.query('SELECT value FROM public.stateplane_qualification WHERE probe_id = $1', [id]);
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
  try { await writer.query('DELETE FROM public.stateplane_qualification WHERE probe_id = $1', [id]); }
  catch { throw new QualificationFailure(['cleanup-delete']); }
  try {
    const remaining = await writer.query('SELECT count(*)::integer AS count FROM public.stateplane_qualification WHERE probe_id = $1', [id]);
    if (remaining.rows[0]?.count !== 0) throw new Error('Qualification row cleanup failed');
  } catch { throw new QualificationFailure(['cleanup-verify']); }
}

async function reserveAttempt(connectionString: string, expectedDatabase: string, expectedRole: string) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const failures: string[] = [];
  let generation: string | undefined;
  try {
    await atStage('writer-connect', () => client.connect());
    await verifyTarget(client, expectedDatabase, expectedRole, false);
    generation = await attemptTransaction(client, async () => {
      await atStage('attempt-reserve', async () => {
        await client.query('CREATE TABLE IF NOT EXISTS public.stateplane_qualification (probe_id uuid PRIMARY KEY, value integer NOT NULL)');
        await client.query('CREATE TABLE IF NOT EXISTS public.stateplane_qualification_attempt (singleton boolean PRIMARY KEY CHECK (singleton), generation bigint NOT NULL, active boolean NOT NULL)');
      });
      await verifyProbeRelations(client, true);
      const reserved = await atStage('attempt-reserve', () => client.query(`INSERT INTO public.stateplane_qualification_attempt (singleton, generation, active)
        VALUES (TRUE, 1, FALSE) ON CONFLICT (singleton) DO UPDATE
        SET generation = public.stateplane_qualification_attempt.generation + 1, active = FALSE
        RETURNING generation`));
      const next = String(reserved.rows[0]?.generation ?? '');
      if (!attemptPattern.test(next)) throw new QualificationFailure(['probe:attempt-reserve']);
      const residual = await atStage('residual-read', () => client.query('SELECT count(*)::integer AS count FROM public.stateplane_qualification'));
      if (residual.rows[0]?.count !== 0) throw new QualificationFailure(['probe:residual-read']);
      return next;
    });
  } catch (error) { failures.push(...(error instanceof QualificationFailure ? error.stages : ['probe:unexpected'])); }
  try { await client.end(); }
  catch { failures.push('close:writer'); }
  if (failures.length) throw new QualificationFailure(failures);
  return { generation };
}

async function startAttempt(connectionString: string, expectedDatabase: string, expectedRole: string, attempt: string) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const failures: string[] = [];
  try {
    await atStage('writer-connect', () => client.connect());
    await verifyTarget(client, expectedDatabase, expectedRole);
    await attemptTransaction(client, () => atStage('attempt-start', async () => {
      await lockProbeRelations(client);
      const opened = await client.query(`UPDATE public.stateplane_qualification_attempt SET active = TRUE
        WHERE singleton = TRUE AND generation = $1 AND active = FALSE RETURNING generation`, [attempt]);
      if (String(opened.rows[0]?.generation ?? '') !== attempt) throw new Error('Stale qualification attempt');
    }));
  } catch (error) { failures.push(...(error instanceof QualificationFailure ? error.stages : ['probe:unexpected'])); }
  try { await client.end(); }
  catch { failures.push('close:writer'); }
  if (failures.length) throw new QualificationFailure(failures);
  return { started: true };
}

async function probe(connectionString: string, expectedDatabase: string, expectedRole: string, attempt: string) {
  const id = crypto.randomUUID();
  const writer = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const reader = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const start = Date.now();
  let rowMayExist = false;
  let readerTransactionOpen = false;
  let result: { pgvectorVersion: string; rollback: boolean; freshRead: boolean; observedConnections: number; maxConnections: number; reservedConnections: number; elapsedMs: number } | undefined;
  const failures: string[] = [];
  try {
    await atStage('writer-connect', () => writer.connect());
    const pgvectorVersion = await verifyTarget(writer, expectedDatabase, expectedRole);
    await atStage('reader-connect', () => reader.connect());
    await atStage('attempt-begin', () => reader.query('BEGIN'));
    readerTransactionOpen = true;
    await atStage('attempt-timeout', () => reader.query("SET LOCAL lock_timeout = '5000ms'"));
    await lockProbeRelations(reader);
    await atStage('attempt-admission', async () => {
      const active = await reader.query('SELECT generation FROM public.stateplane_qualification_attempt WHERE singleton = TRUE AND active = TRUE FOR SHARE');
      if (String(active.rows[0]?.generation ?? '') !== attempt) throw new Error('Qualification attempt is closed');
    });
    await verifyRollback(writer, id, () => { rowMayExist = true; });
    await atStage('committed-insert', () => writer.query('INSERT INTO public.stateplane_qualification (probe_id, value) VALUES ($1, 1)', [id]));
    const { observedConnections, maxConnections, reservedConnections } = await verifyFreshReads(writer, reader, id);
    result = { pgvectorVersion, rollback: true, freshRead: true, observedConnections, maxConnections, reservedConnections, elapsedMs: Date.now() - start };
  } catch (error) {
    failures.push(...(error instanceof QualificationFailure ? error.stages : ['probe:unexpected']));
  }
  if (rowMayExist) {
    try { await cleanupRow(writer, id); }
    catch (error) { failures.push(...(error as QualificationFailure).stages); }
  }
  try { await writer.end(); }
  catch { failures.push('close:writer'); }
  if (readerTransactionOpen) {
    try { await reader.query('ROLLBACK'); }
    catch { failures.push('attempt:rollback'); }
  }
  try { await reader.end(); }
  catch { failures.push('close:reader'); }
  if (failures.length) throw new QualificationFailure(failures);
  if (!result) throw new Error('Qualification result missing');
  return result;
}

async function verifyNoResiduals(connectionString: string, expectedDatabase: string, expectedRole: string, attempt: string) {
  const reader = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const failures: string[] = [];
  try {
    await atStage('reader-connect', () => reader.connect());
    await verifyTarget(reader, expectedDatabase, expectedRole);
    const residualRows = await attemptTransaction(reader, () => atStage('residual-read', async () => {
      await lockProbeRelations(reader);
      const active = await reader.query('SELECT generation, active FROM public.stateplane_qualification_attempt WHERE singleton = TRUE FOR UPDATE');
      if (String(active.rows[0]?.generation ?? '') !== attempt || active.rows[0]?.active !== true) throw new Error('Qualification attempt is not active');
      await reader.query('UPDATE public.stateplane_qualification_attempt SET active = FALSE WHERE singleton = TRUE');
      const rows = await reader.query('SELECT count(*)::integer AS count FROM public.stateplane_qualification');
      if (!Number.isSafeInteger(rows.rows[0]?.count)) throw new Error('Qualification row count unavailable');
      return rows.rows[0].count as number;
    }));
    if (residualRows !== 0) throw new QualificationFailure(['probe:residual-read']);
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
    if (!['/qualify', '/qualify/reserve', '/qualify/start', '/qualify/residual'].includes(path) || request.method !== 'POST') return new Response('Not found', { status: 404 });
    const attempt = request.headers.get('x-stateplane-attempt') ?? '';
    if (env.STATEPLANE_DISPOSABLE !== '1' || !declaredTarget(env.STATEPLANE_PROBE_DATABASE, env.STATEPLANE_PROBE_ROLE) ||
        !env.AUTHORITY?.connectionString || (path !== '/qualify/reserve' && !attemptPattern.test(attempt)) ||
        !(await authorized(request, env.PROBE_TOKEN))) return new Response('Forbidden', { status: 403 });
    try {
      let result;
      if (path === '/qualify/reserve') result = await reserveAttempt(env.AUTHORITY.connectionString, env.STATEPLANE_PROBE_DATABASE, env.STATEPLANE_PROBE_ROLE);
      else if (path === '/qualify/start') result = await startAttempt(env.AUTHORITY.connectionString, env.STATEPLANE_PROBE_DATABASE, env.STATEPLANE_PROBE_ROLE, attempt);
      else if (path === '/qualify') result = await probe(env.AUTHORITY.connectionString, env.STATEPLANE_PROBE_DATABASE, env.STATEPLANE_PROBE_ROLE, attempt);
      else result = await verifyNoResiduals(env.AUTHORITY.connectionString, env.STATEPLANE_PROBE_DATABASE, env.STATEPLANE_PROBE_ROLE, attempt);
      return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      console.error('Qualification failed', error instanceof QualificationFailure ? error.stages.join(',') : 'unexpected');
      return Response.json({ ok: false }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
  }
} satisfies ExportedHandler<Env>;
