import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ closed: 0, connected: 0, failClose: false, denyGrants: false, ownsObject: false, denyVector: false, wrongIdentity: false }));
vi.mock('pg', () => ({ Client: class {
  async connect() { state.connected++; }
  async end() { state.closed++; if (state.failClose) throw new Error('close failed'); }
  async query(sql: string) {
    if (sql.includes('current_database() AS database')) return { rows: [{ database: state.wrongIdentity ? 'other' : 'stateplane_control_dev', role: 'cell_reader', version: 'PostgreSQL 17' }] };
    if (sql.includes('FROM pg_roles')) return { rows: [{ safe_login: true, no_elevated_membership: true,
      no_other_role_membership: true, can_connect: true, no_database_create: true,
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

it('projection queue rejects its batch so Cloudflare can retry and send it to the DLQ', async () => {
  await expect(jobs.queue()).rejects.toThrow('Projection worker is not active');
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
    for (const key of ['wrongIdentity', 'denyGrants', 'ownsObject', 'denyVector'] as const) {
      state[key] = true;
      try {
        const response = await worker.fetch(request(), env as never);
        expect(response.status).toBe(500);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      } finally { state[key] = false; }
    }
  });
});
