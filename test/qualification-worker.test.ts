import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  row: null as number | null,
  deleteMode: 'ok' as 'ok' | 'throw' | 'no-op',
  staleInitialRead: false,
  connections: 0,
  closed: 0
}));

vi.mock('pg', () => ({
  Client: class {
    async connect() { database.connections++; }
    async end() { database.closed++; }
    async query(sql: string) {
      if (sql.includes('FROM pg_extension')) return { rows: [{ extversion: '0.8.6' }] };
      if (sql.includes('::vector')) return { rows: [{ distance: Math.SQRT2 }] };
      if (sql.startsWith('INSERT') && sql.includes('99')) return { rows: [] };
      if (sql.startsWith('INSERT')) { database.row = 1; return { rows: [] }; }
      if (sql.startsWith('UPDATE')) { database.row = 2; return { rows: [] }; }
      if (sql.startsWith('DELETE')) {
        if (database.deleteMode === 'throw') throw new Error('DELETE failed');
        if (database.deleteMode === 'ok') database.row = null;
        return { rows: [] };
      }
      if (sql.includes('count(*)') && sql.includes('stateplane_qualification')) return { rows: [{ count: database.row === null ? 0 : 1 }] };
      if (sql.includes('SELECT value')) return { rows: database.row === null ? [] : [{ value: database.staleInitialRead ? 0 : database.row }] };
      if (sql.includes('pg_stat_activity')) return { rows: [{ count: 2 }] };
      return { rows: [] };
    }
  }
}));

import worker from '../deployment/workers/qualification';

async function qualify(authorization: string | null = 'Bearer disposable-token', disposable = '1') {
  return worker.fetch(new Request('https://preview.example/qualify', {
    method: 'POST', headers: authorization === null ? {} : { authorization }
  }), {
    AUTHORITY: { connectionString: 'postgres://disposable.example/probe' },
    PROBE_TOKEN: 'disposable-token', STATEPLANE_DISPOSABLE: disposable
  } as never);
}

describe('disposable qualification row cleanup', () => {
  beforeEach(() => {
    database.row = null;
    database.deleteMode = 'ok';
    database.staleInitialRead = false;
    database.connections = 0;
    database.closed = 0;
  });

  it('reports success only after the committed probe row is gone', async () => {
    const response = await qualify();
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(database.row).toBeNull();
    expect(database.closed).toBe(2);
  });

  it('fails the probe and closes both clients when DELETE fails', async () => {
    database.deleteMode = 'throw';
    const response = await qualify();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false });
    expect(database.row).toBe(2);
    expect(database.closed).toBe(2);
  });

  it('fails the probe when DELETE returns without removing the row', async () => {
    database.deleteMode = 'no-op';
    const response = await qualify();
    expect(response.status).toBe(500);
    expect(database.row).toBe(2);
    expect(database.closed).toBe(2);
  });

  it('reports both the stale-read and cleanup stages without logging database errors', async () => {
    database.staleInitialRead = true;
    database.deleteMode = 'throw';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await qualify();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false });
      expect(log).toHaveBeenCalledWith('Qualification failed', 'probe:initial-read,cleanup-delete');
      expect(JSON.stringify(log.mock.calls)).not.toContain('DELETE failed');
      expect(database.closed).toBe(2);
    } finally {
      log.mockRestore();
    }
  });

  it('denies missing, wrong and non-Bearer credentials and non-disposable deployments before connecting', async () => {
    for (const [authorization, disposable] of [
      [null, '1'],
      ['Bearer disposable-tokex', '1'],
      ['Basic disposable-token', '1'],
      ['Bearer disposable-token', '0']
    ] as const) {
      const response = await qualify(authorization, disposable);
      expect(response.status).toBe(403);
      expect(database.connections).toBe(0);
      expect(database.row).toBeNull();
    }
  });
});
