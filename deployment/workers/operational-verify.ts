import { Client } from 'pg';
import { operationalGrantsAllowed, operationalGrantsSql } from './role-grants.js';

interface Env {
  AUTHORITY: Hyperdrive;
  PROBE_TOKEN: string;
  STATEPLANE_PROBE_DATABASE: string;
  STATEPLANE_PROBE_ROLE: string;
}

async function authorized(request: Request, expected: string): Promise<boolean> {
  const supplied = request.headers.get('authorization') ?? '';
  if (!supplied.startsWith('Bearer ') || !expected) return false;
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(supplied.slice(7)), digest(expected)]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/verify') return new Response('Not found', { status: 404 });
    if (!env.AUTHORITY?.connectionString || !env.STATEPLANE_PROBE_DATABASE || !env.STATEPLANE_PROBE_ROLE ||
        !(await authorized(request, env.PROBE_TOKEN))) return new Response('Forbidden', { status: 403 });
    const client = new Client({ connectionString: env.AUTHORITY.connectionString,
      connectionTimeoutMillis: 5000, query_timeout: 5000 });
    let evidence: { database: string; role: string } | undefined;
    let failed = false;
    try {
      await client.connect();
      const identity = await client.query('SELECT current_database() AS database, current_user AS role, version() AS version');
      const row = identity.rows[0];
      if (row?.database !== env.STATEPLANE_PROBE_DATABASE || row?.role !== env.STATEPLANE_PROBE_ROLE ||
          !/^PostgreSQL /i.test(row?.version ?? '')) throw new Error('identity');
      const grants = await client.query(operationalGrantsSql);
      if (grants.rows.length !== 1 || !operationalGrantsAllowed(grants.rows[0])) throw new Error('grants');
      const vector = await client.query("SELECT '[1,0,0]'::vector <-> '[0,1,0]'::vector AS distance");
      if (!Number.isFinite(vector.rows[0]?.distance) || Math.abs(vector.rows[0].distance - Math.SQRT2) > 0.00001) {
        throw new Error('pgvector');
      }
      evidence = { database: row.database, role: row.role };
    } catch {
      failed = true;
    } finally {
      try { await client.end(); }
      catch { failed = true; }
    }
    if (failed || !evidence) return Response.json({ ok: false }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    return Response.json({ ok: true, ...evidence, pgvector: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
} satisfies ExportedHandler<Env>;
