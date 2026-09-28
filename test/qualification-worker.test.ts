import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  row: null as number | null,
  deleteMode: 'ok' as 'ok' | 'throw' | 'no-op',
  staleInitialRead: false,
  staleFreshRead: false,
  vectorDistance: Math.SQRT2 as number | string | undefined,
  vectorMissingRow: false,
  connections: 0,
  closed: 0,
  transactionRow: false,
  rollbackLeavesRow: false,
  rollbackFailure: false,
  insertFailure: false,
  failQuery: '' as string,
  endFailure: false,
  queryTimeout: 0,
  maxConnections: 100,
  otherConnections: 0,
  reservedConnections: 3,
  valueReads: 0,
  queries: [] as string[],
  targetDatabase: 'sta4_aaaaaaaaaaaaaaaa_dev_ap_southeast',
  targetRole: 'sta4_probe_aaaaaaaaaaaaaaaa'
}));

vi.mock('pg', () => ({
  Client: class {
    constructor(options: { query_timeout: number }) { database.queryTimeout = options.query_timeout; }
    async connect() { database.connections++; }
    async end() { database.closed++; if (database.endFailure) throw new Error('close failed'); }
    async query(sql: string) {
      database.queries.push(sql);
      if (database.failQuery && sql.includes(database.failQuery)) throw new Error('query timeout');
      if (sql === 'BEGIN') { database.transactionRow = false; return { rows: [] }; }
      if (sql === 'ROLLBACK') {
        if (database.rollbackFailure) throw new Error('rollback failed');
        if (database.rollbackLeavesRow && database.transactionRow) database.row = 99;
        database.transactionRow = false;
        return { rows: [] };
      }
      if (sql === 'COMMIT') {
        if (database.transactionRow) database.row = 99;
        database.transactionRow = false;
        return { rows: [] };
      }
      if (sql.includes('current_database() AS database')) return { rows: [{ database: database.targetDatabase, role: database.targetRole }] };
      if (sql.includes('FROM pg_extension')) return { rows: [{ extversion: '0.8.6' }] };
      if (sql.includes('::vector')) return { rows: database.vectorMissingRow ? [] : [{ distance: database.vectorDistance }] };
      if (sql.startsWith('INSERT') && sql.includes('99')) { database.transactionRow = true; if (database.insertFailure) throw new Error('insert failed'); return { rows: [] }; }
      if (sql.startsWith('INSERT')) { database.row = 1; return { rows: [] }; }
      if (sql.startsWith('UPDATE')) { database.row = 2; return { rows: [] }; }
      if (sql.startsWith('DELETE')) {
        if (database.deleteMode === 'throw') throw new Error('DELETE failed');
        if (database.deleteMode === 'ok') { database.row = null; database.transactionRow = false; }
        return { rows: [] };
      }
      if (sql.includes('count(*)') && sql.includes('stateplane_qualification')) return { rows: [{ count: database.row === null && !database.transactionRow ? 0 : 1 }] };
      if (sql.includes('SELECT value')) {
        database.valueReads++;
        return { rows: database.row === null ? [] : [{ value: (database.staleInitialRead && database.valueReads === 1) || (database.staleFreshRead && database.valueReads === 2) ? 0 : database.row }] };
      }
      if (sql.includes('pg_stat_activity')) return { rows: [{
        count: 2 + database.otherConnections,
        max_connections: database.maxConnections,
        reserved_connections: sql.includes('reserved_connections') ? database.reservedConnections : undefined
      }] };
      return { rows: [] };
    }
  }
}));

import worker from '../deployment/workers/qualification';

async function qualify(authorization: string | null = 'Bearer disposable-token', disposable = '1', bindings: Record<string, unknown> = {}) {
  return worker.fetch(new Request('https://preview.example/qualify', {
    method: 'POST', headers: authorization === null ? {} : { authorization }
  }), {
    AUTHORITY: { connectionString: 'postgres://disposable.example/probe' },
    PROBE_TOKEN: 'disposable-token', STATEPLANE_DISPOSABLE: disposable,
    STATEPLANE_PROBE_DATABASE: 'sta4_aaaaaaaaaaaaaaaa_dev_ap_southeast', STATEPLANE_PROBE_ROLE: 'sta4_probe_aaaaaaaaaaaaaaaa',
    ...bindings
  } as never);
}

describe('disposable qualification row cleanup', () => {
  beforeEach(() => {
    database.row = null;
    database.deleteMode = 'ok';
    database.staleInitialRead = false;
    database.staleFreshRead = false;
    database.valueReads = 0;
    database.queries = [];
    database.vectorDistance = Math.SQRT2;
    database.vectorMissingRow = false;
    database.connections = 0;
    database.closed = 0;
    database.transactionRow = false;
    database.rollbackLeavesRow = false;
    database.rollbackFailure = false;
    database.insertFailure = false;
    database.failQuery = '';
    database.endFailure = false;
    database.queryTimeout = 0;
    database.maxConnections = 100;
    database.otherConnections = 0;
    database.reservedConnections = 3;
    database.targetDatabase = 'sta4_aaaaaaaaaaaaaaaa_dev_ap_southeast';
    database.targetRole = 'sta4_probe_aaaaaaaaaaaaaaaa';
  });

  it('reports success only after the committed probe row is gone', async () => {
    const response = await qualify();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pgvectorVersion: '0.8.6', rollback: true, freshRead: true, observedConnections: 2, maxConnections: 100, reservedConnections: 3 });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(database.queryTimeout).toBe(5000);
    expect(database.row).toBeNull();
    expect(database.closed).toBe(2);
  });

  it('fails if the database cannot report sufficient connection capacity', async () => {
    database.maxConnections = 1;
    expect((await qualify()).status).toBe(500);
    expect(database.row).toBeNull();
  });

  it('counts other database and role sessions and reports reserved slots', async () => {
    database.maxConnections = 20;
    database.otherConnections = 14;
    database.reservedConnections = 2;
    const response = await qualify();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ observedConnections: 16, maxConnections: 20, reservedConnections: 2 });
    expect(database.queries.find(sql => sql.includes('pg_stat_activity'))).not.toContain('WHERE datname');
    expect(database.row).toBeNull();
  });

  it('rejects missing and nonnumeric pgvector results before writing a probe row', async () => {
    for (const distance of [undefined, 'not-a-number', NaN]) {
      database.vectorDistance = distance;
      const response = await qualify();
      expect(response.status).toBe(500);
      expect(database.row).toBeNull();
    }
    database.vectorMissingRow = true;
    const response = await qualify();
    expect(response.status).toBe(500);
    expect(database.row).toBeNull();
    expect(database.closed).toBe(8);
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

  it('fails and removes a row when rollback is not atomic', async () => {
    database.rollbackLeavesRow = true;
    const response = await qualify();
    expect(response.status).toBe(500);
    expect(database.row).toBeNull();
    expect(database.transactionRow).toBe(false);
    expect(database.queries).toContain('ROLLBACK');
    expect(database.queries.some(sql => sql.startsWith('DELETE FROM stateplane_qualification'))).toBe(true);
    expect(database.queries.filter(sql => sql.includes('SELECT count(*)') && sql.includes('stateplane_qualification'))).toHaveLength(2);
    expect(database.closed).toBe(2);
  });

  it('preserves the failed insert stage and still removes a possible row', async () => {
    database.insertFailure = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await qualify()).status).toBe(500);
      expect(log).toHaveBeenCalledWith('Qualification failed', 'probe:transaction-insert');
      expect(database.transactionRow).toBe(false);
    } finally { log.mockRestore(); }
  });

  it('reports a failed rollback and cleans up a possible row', async () => {
    database.rollbackFailure = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await qualify()).status).toBe(500);
      expect(log).toHaveBeenCalledWith('Qualification failed', 'probe:transaction-rollback');
      expect(database.row).toBeNull();
      expect(database.transactionRow).toBe(false);
      expect(database.queries.some(sql => sql.startsWith('DELETE FROM stateplane_qualification'))).toBe(true);
      expect(database.queries.filter(sql => sql.includes('SELECT count(*)') && sql.includes('stateplane_qualification'))).toHaveLength(1);
      expect(database.closed).toBe(2);
    } finally { log.mockRestore(); }
  });

  it('fails when either client cannot close', async () => {
    database.endFailure = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await qualify()).status).toBe(500);
      expect(log).toHaveBeenCalledWith('Qualification failed', 'close:writer,close:reader');
    } finally { log.mockRestore(); }
  });

  it('fails a stale read after a committed mutation', async () => {
    database.staleFreshRead = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await qualify()).status).toBe(500);
      expect(database.row).toBeNull();
      expect(log).toHaveBeenCalledWith('Qualification failed', 'probe:fresh-read');
    } finally { log.mockRestore(); }
  });

  it('fails a timed-out read and runs probe cleanup', async () => {
    database.failQuery = 'SELECT value';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await qualify()).status).toBe(500);
      expect(database.row).toBeNull();
      expect(log).toHaveBeenCalledWith('Qualification failed', 'probe:initial-read');
    } finally { log.mockRestore(); }
  });

  it('rejects a mismatched live database or role before creating the probe table', async () => {
    for (const [key, value] of [['targetDatabase', 'stateplane_prod_ap_southeast'], ['targetRole', 'owner']] as const) {
      database[key] = value;
      expect((await qualify()).status).toBe(500);
      expect(database.row).toBeNull();
      database[key] = key === 'targetDatabase' ? 'sta4_aaaaaaaaaaaaaaaa_dev_ap_southeast' : 'sta4_probe_aaaaaaaaaaaaaaaa';
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

  it('denies undeclared, malformed and missing target bindings before connecting', async () => {
    for (const bindings of [
      { STATEPLANE_PROBE_DATABASE: 'sta4_aaaaaaaaaaaaaaaa_prod_eu_west' },
      { STATEPLANE_PROBE_DATABASE: 'sta4_aaaaaaaaaaaaaaaa_dev_unknown' },
      { STATEPLANE_PROBE_DATABASE: 'stateplane_prod_ap_southeast' },
      { STATEPLANE_PROBE_DATABASE: undefined },
      { STATEPLANE_PROBE_ROLE: 'sta4_probe_bbbbbbbbbbbbbbbb' },
      { STATEPLANE_PROBE_ROLE: undefined },
      { AUTHORITY: undefined }
    ]) {
      expect((await qualify('Bearer disposable-token', '1', bindings)).status).toBe(403);
      expect(database.connections).toBe(0);
    }
  });

  it('admits every declared development and production cell', async () => {
    for (const suffix of ['dev_ap_southeast', 'dev_us_east', 'dev_eu_west', 'prod_ap_southeast', 'prod_us_east']) {
      const target = `sta4_aaaaaaaaaaaaaaaa_${suffix}`;
      database.targetDatabase = target;
      expect((await qualify('Bearer disposable-token', '1', { STATEPLANE_PROBE_DATABASE: target })).status).toBe(200);
      expect(database.row).toBeNull();
    }
  });

  it('hashes unequal-length Bearer candidates before denial', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      expect((await qualify('Bearer x')).status).toBe(403);
      expect(digest).toHaveBeenCalledTimes(2);
      expect(database.connections).toBe(0);
    } finally { digest.mockRestore(); }
  });
});
