import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ closed: 0, connected: 0, failClose: false, denyGrants: false, denyCatalog: false, ownsObject: false, denyVector: false, wrongIdentity: false }));
const cell = vi.hoisted(() => ({ pools: 0, ended: 0, poolOptions: [] as unknown[], claims: [] as unknown[][], released: [] as unknown[], stepped: 0, processed: [] as unknown[] }));
vi.mock('@stateplane/postgres', async importOriginal => ({
  CLIENT_READ_TIMEOUT_MS: (await importOriginal<typeof import('@stateplane/postgres')>()).CLIENT_READ_TIMEOUT_MS,
  PostgresAuthority: class {},
  PostgresOutbox: class {
    async claim() { return { messages: cell.claims.shift() ?? [], scan: 'whole' }; }
    async release(messages: unknown[]) { cell.released.push(...messages); return messages.length; }
    async stepReconciliations() { cell.stepped++; return 0; }
    async process(message: { attempt: number }) {
      cell.processed.push(message);
      if (message.attempt === 9) throw new Error('connection refused');
      return message.attempt === 2 ? 'failed' : 'applied';
    }
  }
}));
vi.mock('pg', () => ({ default: { Pool: class { constructor(options: unknown) { cell.pools++; cell.poolOptions.push(options); } async end() { cell.ended++; } } }, Client: class {
  async connect() { state.connected++; }
  async end() { state.closed++; if (state.failClose) throw new Error('close failed'); }
  async query(sql: string) {
    if (sql.includes('current_database() AS database')) return { rows: [{ database: state.wrongIdentity ? 'other' : 'stateplane_control_dev', role: 'cell_reader', version: 'PostgreSQL 17' }] };
    if (sql.includes('FROM pg_roles')) return { rows: [{ safe_login: true, no_elevated_membership: true,
      no_other_role_membership: true, no_parameter_admin: true,
      no_restricted_catalog_execute: !state.denyCatalog,
      can_connect: true, no_database_create: true,
      can_use_schema: true, no_public_schema_create: !state.denyGrants,
      no_other_schema_create: true, no_owned_objects: !state.ownsObject }] };
    if (sql.includes('::vector')) return { rows: [{ distance: state.denyVector ? 0 : Math.SQRT2 }] };
    throw new Error('unexpected SQL');
  }
} }));

import worker from '../deployment/workers/operational-verify';
import jobs from '../deployment/workers/jobs';

const env = { AUTHORITY: { connectionString: 'postgres://example/probe' }, PROBE_TOKEN: 'secret',
  STATEPLANE_PROBE_DATABASE: 'stateplane_control_dev', STATEPLANE_PROBE_ROLE: 'cell_reader' };
const request = (token = 'secret') => new Request('https://preview.example/verify', {
  method: 'POST', headers: { authorization: `Bearer ${token}` }
});

const hint = (attempt: number) => ({ eventId: 'evt_00000000-0000-4000-8000-000000000000', attempt });
function batch(bodies: unknown[]) {
  const settled: string[] = [];
  const messages = bodies.map((body, index) => ({ body, ack: () => settled.push(`ack:${index}`), retry: () => settled.push(`retry:${index}`) }));
  return { settled, value: { messages } as never };
}
const jobsEnv = (sendBatch = vi.fn(async () => ({}))) => ({ AUTHORITY: { connectionString: 'postgres://example/cell' },
  PROJECTION_JOBS: { sendBatch } }) as never;

describe('cell jobs Worker', () => {
  it('fails closed without its authority binding so Cloudflare redelivers the batch', async () => {
    const delivered = batch([hint(1)]);
    await expect(jobs.queue(delivered.value, {} as never)).rejects.toThrow('Cell authority binding is missing');
    await expect(jobs.scheduled({} as never, {} as never)).rejects.toThrow('Cell authority binding is missing');
    expect(delivered.settled).toEqual([]);
  });

  it('bounds client reads past every server bound, so only a lost session hits the read timeout', async () => {
    const actual = await vi.importActual<typeof import('@stateplane/postgres')>('@stateplane/postgres');
    // The server ends a statement by the request budget and a stalled apply 5 s after it.
    const serverBound = new actual.PostgresAuthority({ connect: async () => { throw new Error('unused'); } } as never, 1)
      .requestBudgetMs + 5_000;
    await jobs.queue(batch([]).value, jobsEnv());
    const { query_timeout: readTimeout } = cell.poolOptions.at(-1) as { query_timeout: number };
    expect(readTimeout).toBe(actual.CLIENT_READ_TIMEOUT_MS);
    expect(readTimeout).toBeGreaterThan(serverBound);
  });

  it('acks settled and malformed hints and redelivers only infrastructure failures', async () => {
    const before = { ended: cell.ended, pools: cell.pools };
    const delivered = batch([hint(1), { eventId: 'evt_x', attempt: 1 }, hint(2), hint(9)]);
    await jobs.queue(delivered.value, jobsEnv());
    expect(delivered.settled.sort()).toEqual(['ack:0', 'ack:1', 'ack:2', 'retry:3']);
    expect(cell.processed).toEqual([hint(1), hint(2), hint(9)]);
    expect([cell.pools - before.pools, cell.ended - before.ended]).toEqual([1, 1]);
  });

  it('sends leased hints as plain bodies until nothing is due and releases the batch when the Queue rejects it', async () => {
    cell.claims = [[hint(1)], [hint(3)]];
    const sendBatch = vi.fn(async () => ({}));
    await jobs.scheduled({} as never, jobsEnv(sendBatch));
    expect(sendBatch.mock.calls).toEqual([[[{ body: hint(1) }]], [[{ body: hint(3) }]]]);
    expect([cell.claims, cell.released, cell.stepped]).toEqual([[], [], 1]);
    const ended = cell.ended;
    cell.claims = [[hint(1)]];
    await expect(jobs.scheduled({} as never, jobsEnv(vi.fn(async () => { throw new Error('queue unavailable'); }))))
      .rejects.toThrow('Projection dispatch released 1 leases');
    expect([cell.released, cell.stepped, cell.ended - ended]).toEqual([[hint(1)], 2, 1]);
  });
});

describe('operational Worker connection proof', () => {
  it('returns success only after the SQL client closes', async () => {
    state.closed = 0; state.connected = 0; state.failClose = false;
    const success = await worker.fetch(request(), env as never);
    expect(success.status).toBe(200);
    expect(success.headers.get('Cache-Control')).toBe('no-store');
    expect(await success.json()).toMatchObject({ ok: true, database: 'stateplane_control_dev', pgvector: true });
    expect(state.closed).toBe(1);
    state.failClose = true;
    const failed = await worker.fetch(request(), env as never);
    expect(failed.status).toBe(500);
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(await failed.json()).toEqual({ ok: false });
    expect(state.closed).toBe(2);
  });

  it('rejects bad authorization before opening a connection', async () => {
    state.connected = 0; state.failClose = false;
    expect((await worker.fetch(request('wrong'), env as never)).status).toBe(403);
    expect(state.connected).toBe(0);
    expect((await worker.fetch(new Request('https://preview.example/other', { method: 'POST' }), env as never)).status).toBe(404);
    expect((await worker.fetch(new Request('https://preview.example/verify'), env as never)).status).toBe(404);
    expect(state.connected).toBe(0);
  });

  it('fails closed for wrong SQL identity, excessive grants and broken pgvector', async () => {
    for (const key of ['wrongIdentity', 'denyGrants', 'denyCatalog', 'ownsObject', 'denyVector'] as const) {
      state[key] = true;
      try {
        const response = await worker.fetch(request(), env as never);
        expect(response.status).toBe(500);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      } finally { state[key] = false; }
    }
  });
});
