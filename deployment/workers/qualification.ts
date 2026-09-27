import { Client } from 'pg';

interface Env {
  AUTHORITY: Hyperdrive;
  PROBE_TOKEN: string;
  STATEPLANE_DISPOSABLE: string;
}

class QualificationFailure extends Error {
  constructor(readonly stages: string[]) {
    super('Disposable qualification failed');
  }
}

async function authorized(request: Request, expected: string): Promise<boolean> {
  const supplied = request.headers.get('authorization') ?? '';
  if (!supplied.startsWith('Bearer ') || !expected || supplied.length !== expected.length + 7) return false;
  const encode = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([encode(supplied.slice(7)), encode(expected)]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function probe(connectionString: string) {
  const id = crypto.randomUUID();
  const writer = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  const reader = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  const start = Date.now();
  let writerConnected = false;
  let rowMayExist = false;
  let result: { pgvectorVersion: string; rollback: boolean; freshRead: boolean; observedConnections: number; elapsedMs: number } | undefined;
  const failureStages: string[] = [];
  let stage = 'writer-connect';
  try {
    await writer.connect();
    writerConnected = true;
    stage = 'pgvector-extension';
    const extension = await writer.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    if (!extension.rows[0]) throw new Error('pgvector is not installed');
    stage = 'pgvector-distance';
    const vector = await writer.query("SELECT '[1,0,0]'::vector <-> '[0,1,0]'::vector AS distance");
    const distance: unknown = vector.rows[0]?.distance;
    if (typeof distance !== 'number' || !Number.isFinite(distance) || Math.abs(distance - Math.sqrt(2)) > 0.00001) throw new Error('pgvector distance mismatch');
    stage = 'probe-table';
    await writer.query('CREATE TABLE IF NOT EXISTS stateplane_qualification (probe_id uuid PRIMARY KEY, value integer NOT NULL)');
    stage = 'transaction-begin';
    await writer.query('BEGIN');
    try {
      stage = 'transaction-insert';
      await writer.query('SET LOCAL statement_timeout = 5000');
      await writer.query('INSERT INTO stateplane_qualification (probe_id, value) VALUES ($1, 99)', [id]);
    } finally {
      stage = 'transaction-rollback';
      await writer.query('ROLLBACK');
    }
    stage = 'rollback-read';
    const rolledBack = await writer.query('SELECT count(*)::integer AS count FROM stateplane_qualification WHERE probe_id = $1', [id]);
    if (rolledBack.rows[0].count !== 0) throw new Error('Rollback was not atomic');
    rowMayExist = true;
    stage = 'committed-insert';
    await writer.query('INSERT INTO stateplane_qualification (probe_id, value) VALUES ($1, 1)', [id]);
    stage = 'reader-connect';
    await reader.connect();
    stage = 'initial-read';
    const first = await reader.query('SELECT value FROM stateplane_qualification WHERE probe_id = $1', [id]);
    if (first.rows[0]?.value !== 1) throw new Error('Initial read was stale');
    stage = 'committed-update';
    await writer.query('UPDATE stateplane_qualification SET value = 2 WHERE probe_id = $1', [id]);
    stage = 'fresh-read';
    const fresh = await reader.query('SELECT value FROM stateplane_qualification WHERE probe_id = $1', [id]);
    if (fresh.rows[0]?.value !== 2) throw new Error('Fresh read was stale');
    stage = 'connection-count';
    const activity = await reader.query('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user');
    stage = 'result';
    result = { pgvectorVersion: extension.rows[0].extversion, rollback: true, freshRead: true, observedConnections: activity.rows[0].count, elapsedMs: Date.now() - start };
  } catch {
    failureStages.push(`probe:${stage}`);
  }
  try {
    if (writerConnected && rowMayExist) {
      stage = 'cleanup-delete';
      await writer.query('DELETE FROM stateplane_qualification WHERE probe_id = $1', [id]);
      stage = 'cleanup-verify';
      const remaining = await writer.query('SELECT count(*)::integer AS count FROM stateplane_qualification WHERE probe_id = $1', [id]);
      if (remaining.rows[0]?.count !== 0) throw new Error('Qualification row cleanup failed');
    }
  } catch {
    failureStages.push(stage);
  }
  await Promise.allSettled([writer.end(), reader.end()]);
  if (failureStages.length) throw new QualificationFailure(failureStages);
  if (!result) throw new Error('Qualification result missing');
  return result;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/qualify' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (env.STATEPLANE_DISPOSABLE !== '1' || !(await authorized(request, env.PROBE_TOKEN))) return new Response('Forbidden', { status: 403 });
    try {
      return Response.json({ ok: true, ...(await probe(env.AUTHORITY.connectionString)) }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      console.error('Qualification failed', error instanceof QualificationFailure ? error.stages.join(',') : 'unexpected');
      return Response.json({ ok: false }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
  }
} satisfies ExportedHandler<Env>;
