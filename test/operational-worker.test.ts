import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ closed: 0, connected: 0, failClose: false }));
vi.mock('pg', () => ({ Client: class {
  async connect() { state.connected++; }
  async end() { state.closed++; if (state.failClose) throw new Error('close failed'); }
  async query(sql: string) {
    if (sql.includes('current_database() AS database')) return { rows: [{ database: 'stateplane_control_dev', role: 'cell_reader', version: 'PostgreSQL 17' }] };
    if (sql.includes('FROM pg_roles')) return { rows: [{ safe_login: true, no_elevated_membership: true,
      no_other_role_membership: true, can_connect: true, no_database_create: true,
      can_use_schema: true, no_public_schema_create: true, no_other_schema_create: true }] };
    if (sql.includes('::vector')) return { rows: [{ distance: Math.SQRT2 }] };
    throw new Error('unexpected SQL');
  }
} }));

import worker from '../deployment/workers/operational-verify';

const env = { AUTHORITY: { connectionString: 'postgres://example/probe' }, PROBE_TOKEN: 'secret',
  STATEPLANE_PROBE_DATABASE: 'stateplane_control_dev', STATEPLANE_PROBE_ROLE: 'cell_reader' };
const request = (token = 'secret') => new Request('https://preview.example/verify', {
  method: 'POST', headers: { authorization: `Bearer ${token}` }
});

describe('operational Worker connection proof', () => {
  it('returns success only after the SQL client closes', async () => {
    state.closed = 0; state.connected = 0; state.failClose = false;
    const success = await worker.fetch(request(), env as never);
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ ok: true, database: 'stateplane_control_dev', pgvector: true });
    expect(state.closed).toBe(1);
    state.failClose = true;
    const failed = await worker.fetch(request(), env as never);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ ok: false });
    expect(state.closed).toBe(2);
  });

  it('rejects bad authorization before opening a connection', async () => {
    state.connected = 0; state.failClose = false;
    expect((await worker.fetch(request('wrong'), env as never)).status).toBe(403);
    expect(state.connected).toBe(0);
  });
});
