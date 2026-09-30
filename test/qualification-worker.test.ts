import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  row: null as number | null,
  orphanRows: 0,
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
  bootstrapConflicts: 0,
  endFailure: false,
  queryTimeout: 0,
  maxConnections: 100,
  otherConnections: 0,
  reservedConnections: 3,
  valueReads: 0,
  attemptId: '1',
  storedAttemptId: '1' as string | null,
  activeAttempt: true,
  relationKind: 'r',
  relationOwner: 'sta4_probe_aaaaaaaaaaaaaaaa',
  relationColumnsValid: true,
  relationSchema: 'public',
  relationTriggers: 0,
  queries: [] as string[],
  targetDatabase: 'sta4_aaaaaaaaaaaaaaaa_dev_ap_southeast',
  targetRole: 'sta4_probe_aaaaaaaaaaaaaaaa',
  grants: {
    safe_login: true, no_elevated_membership: true, no_other_role_membership: true,
    no_parameter_admin: true, can_connect: true,
    no_database_create: true, can_use_schema: true, can_create_probe_table: true,
    no_other_schema_create: true, no_other_table_access: true,
    no_sequence_access: true, no_other_routine_execute: true, can_execute_distance: true
  } as Record<string, boolean> | null
}));

vi.mock('pg', () => ({
  Client: class {
    constructor(options: { query_timeout: number }) { database.queryTimeout = options.query_timeout; }
    async connect() { database.connections++; }
    async end() { database.closed++; if (database.endFailure) throw new Error('close failed'); }
    async query(sql: string, parameters?: unknown[]) {
      database.queries.push(sql);
      if (sql.startsWith('CREATE TABLE') && database.bootstrapConflicts > 0) {
        database.bootstrapConflicts--;
        throw Object.assign(new Error('concurrent catalog creation'), { code: '23505' });
      }
      if (database.failQuery && sql.includes(database.failQuery)) throw new Error('query timeout');
      if (sql.startsWith('SET LOCAL lock_timeout')) return { rows: [] };
      if (sql.startsWith('SELECT current_user AS current_role, probe.*')) {
        const column = (name: string, type: string) => ({ name, type, notNull: true, default: null, identity: '', generated: '' });
        const probeColumns = [column('probe_id', 'uuid'), column('value', 'integer')];
        const attemptColumns = [column('singleton', 'boolean'), column('generation', 'bigint'), column('active', 'boolean')];
        if (!database.relationColumnsValid) probeColumns[1].type = 'text';
        const relation = (relname: string, columns: unknown[], constraints: unknown[]) => ({
          current_role: database.targetRole, relname, relkind: database.relationKind, relpersistence: 'p',
          relrowsecurity: false, relforcerowsecurity: false, owner: database.relationOwner,
          triggers: database.relationTriggers, rules: 0, inheritance: 0, schema: database.relationSchema, columns, constraints
        });
        const primary = (name: string) => ({ kind: 'p', columns: [1], definition: `PRIMARY KEY (${name})` });
        return { rows: [relation('stateplane_qualification', probeColumns, [primary('probe_id')]),
          relation('stateplane_qualification_attempt', attemptColumns,
            [{ kind: 'c', columns: [1], definition: 'CHECK (singleton)' }, primary('singleton')])] };
      }
      if (sql.startsWith('SELECT generation') && sql.includes('stateplane_qualification_attempt')) {
        if (database.storedAttemptId === null) return { rows: [] };
        if (sql.includes('AND active = TRUE') && !database.activeAttempt) return { rows: [] };
        return { rows: [{ generation: database.storedAttemptId, active: database.activeAttempt }] };
      }
      if (sql.startsWith('UPDATE public.stateplane_qualification_attempt')) {
        if (sql.includes('SET active = TRUE')) {
          if (String(parameters?.[0]) !== database.storedAttemptId || database.activeAttempt) return { rows: [] };
          database.activeAttempt = true;
        } else database.activeAttempt = false;
        return { rows: [{ generation: database.storedAttemptId }] };
      }
      if (sql.startsWith('INSERT INTO public.stateplane_qualification_attempt')) {
        database.storedAttemptId = String(Number(database.storedAttemptId ?? 0) + 1);
        database.activeAttempt = false;
        return { rows: [{ generation: database.storedAttemptId }] };
      }
      if (sql === 'BEGIN') { database.transactionRow = false; return { rows: [] }; }
      if (sql === 'ROLLBACK') {
        if (database.rollbackFailure) { database.rollbackFailure = false; throw new Error('rollback failed'); }
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
      if (sql.includes('FROM pg_roles')) return { rows: database.grants === null ? [] : [database.grants] };
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
      if (sql === 'SELECT count(*)::integer AS count FROM public.stateplane_qualification') return { rows: [{ count: database.orphanRows + (database.row === null ? 0 : 1) }] };
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

async function qualify(authorization: string | null = 'Bearer disposable-token', disposable = '1', bindings: Record<string, unknown> = {}, path = '/qualify') {
  return worker.fetch(new Request(`https://preview.example${path}`, {
    method: 'POST', headers: authorization === null
      ? { 'x-stateplane-attempt': database.attemptId }
      : { authorization, 'x-stateplane-attempt': database.attemptId }
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
    database.bootstrapConflicts = 0;
    database.orphanRows = 0;
    database.deleteMode = 'ok';
    database.staleInitialRead = false;
    database.staleFreshRead = false;
    database.valueReads = 0;
    database.attemptId = '1';
    database.storedAttemptId = database.attemptId;
    database.activeAttempt = true;
    database.relationKind = 'r';
    database.relationOwner = 'sta4_probe_aaaaaaaaaaaaaaaa';
    database.relationColumnsValid = true;
    database.relationSchema = 'public';
    database.relationTriggers = 0;
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
    database.grants = {
      safe_login: true, no_elevated_membership: true, no_other_role_membership: true,
      no_parameter_admin: true, can_connect: true,
      no_database_create: true, can_use_schema: true, can_create_probe_table: true,
      no_other_schema_create: true, no_other_table_access: true,
      no_sequence_access: true, no_other_routine_execute: true, can_execute_distance: true
    };
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

  it('fences late old probes and starts only a newer replay after zero residual rows', async () => {
    const old = database.attemptId;
    const newer = '2';
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/reserve')).status).toBe(200);
    database.attemptId = newer;
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/start')).status).toBe(200);
    database.attemptId = old;
    expect((await qualify()).status).toBe(500);
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/start')).status).toBe(500);
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/residual')).status).toBe(500);
    expect(database.row).toBeNull();
    database.attemptId = newer;
    expect((await qualify()).status).toBe(200);
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/residual')).status).toBe(200);
    expect((await qualify()).status).toBe(500);
    database.attemptId = old;
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/start')).status).toBe(500);
    expect(database.row).toBeNull();
    database.attemptId = newer;
    database.orphanRows = 1;
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/reserve')).status).toBe(500);
    database.orphanRows = 0;
    database.attemptId = '4';
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/reserve')).status).toBe(200);
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/start')).status).toBe(200);
  });

  it('initializes the fence before the first probe on a fresh disposable database', async () => {
    database.storedAttemptId = null;
    database.activeAttempt = false;
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/reserve')).status).toBe(200);
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/start')).status).toBe(200);
    expect(database.storedAttemptId).toBe(database.attemptId);
    expect((await qualify()).status).toBe(200);
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/residual')).status).toBe(200);
  });

  it('retries only a rolled-back bootstrap catalog conflict and rechecks target admission', async () => {
    database.storedAttemptId = null;
    database.activeAttempt = false;
    database.bootstrapConflicts = 1;
    expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/reserve')).status).toBe(200);
    expect(database.queries.filter(sql => sql === 'ROLLBACK')).toHaveLength(1);
    expect(database.queries.filter(sql => sql.includes('FROM pg_roles'))).toHaveLength(2);
    expect(database.closed).toBe(1);

    database.queries = [];
    database.bootstrapConflicts = 1;
    database.rollbackFailure = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/reserve')).status).toBe(500);
      expect(database.queries.filter(sql => sql.startsWith('CREATE TABLE'))).toHaveLength(1);
      expect(log).toHaveBeenLastCalledWith('Qualification failed', 'probe:attempt-bootstrap,attempt:rollback');
    } finally { log.mockRestore(); }
  });

  it('rejects an orphan from a prior interrupted probe in the final table-wide read', async () => {
    expect((await qualify()).status).toBe(200);
    const clean = await qualify('Bearer disposable-token', '1', {}, '/qualify/residual');
    expect(clean.status).toBe(200);
    expect(await clean.json()).toEqual({ ok: true, residualRows: 0 });
    database.queries = [];
    database.closed = 0;
    database.orphanRows = 1;
    database.activeAttempt = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await qualify('Bearer disposable-token', '1', {}, '/qualify/residual');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false });
      expect(log).toHaveBeenCalledWith('Qualification failed', 'probe:residual-read');
      expect(database.queries).toContain('SELECT count(*)::integer AS count FROM public.stateplane_qualification');
      expect(database.closed).toBe(1);
    } finally { log.mockRestore(); }
  });

  it('requires authorization and fails closed when the final residual read fails', async () => {
    expect((await qualify(null, '1', {}, '/qualify/residual')).status).toBe(403);
    expect(database.connections).toBe(0);
    database.failQuery = 'SELECT count(*)::integer AS count FROM public.stateplane_qualification';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/residual')).status).toBe(500);
      expect(log).toHaveBeenCalledWith('Qualification failed', 'probe:residual-read');
      expect(database.closed).toBe(1);
    } finally { log.mockRestore(); }
  });

  it('preserves rollback and client-close failures for attempt lifecycle endpoints', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const path of ['/qualify/start', '/qualify/residual']) {
        database.activeAttempt = path === '/qualify/residual';
        database.failQuery = 'SET LOCAL lock_timeout';
        database.rollbackFailure = true;
        database.queries = [];
        expect((await qualify('Bearer disposable-token', '1', {}, path)).status).toBe(500);
        expect(log).toHaveBeenLastCalledWith('Qualification failed', 'probe:attempt-timeout,attempt:rollback');
        expect(database.queries).toContain('ROLLBACK');
        database.failQuery = '';
      }
      database.activeAttempt = false;
      database.endFailure = true;
      expect((await qualify('Bearer disposable-token', '1', {}, '/qualify/start')).status).toBe(500);
      expect(log).toHaveBeenLastCalledWith('Qualification failed', 'close:writer');
    } finally { log.mockRestore(); }
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
    expect(database.queries.some(sql => sql.startsWith('DELETE FROM public.stateplane_qualification'))).toBe(true);
    expect(database.queries.filter(sql => sql.startsWith('SELECT count(*)') && sql.includes('stateplane_qualification'))).toHaveLength(2);
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
      expect(database.queries.some(sql => sql.startsWith('DELETE FROM public.stateplane_qualification'))).toBe(true);
      expect(database.queries.filter(sql => sql.startsWith('SELECT count(*)') && sql.includes('stateplane_qualification'))).toHaveLength(1);
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

  it('rejects elevated and unavailable effective grants before any DDL or row mutation', async () => {
    for (const key of ['safe_login', 'no_elevated_membership', 'no_other_role_membership', 'no_parameter_admin', 'no_database_create', 'no_other_schema_create', 'no_other_table_access',
      'no_sequence_access', 'no_other_routine_execute', 'can_execute_distance', 'can_connect', 'can_use_schema', 'can_create_probe_table']) {
      const beforeClose = database.closed;
      database.grants = { ...database.grants, [key]: false };
      expect((await qualify()).status).toBe(500);
      expect(database.queries.some(sql => sql.startsWith('CREATE TABLE') || sql.startsWith('INSERT'))).toBe(false);
      expect(database.closed - beforeClose).toBe(2);
      database.grants = { ...database.grants, [key]: true };
      database.queries = [];
    }
    database.grants = null;
    let beforeClose = database.closed;
    expect((await qualify()).status).toBe(500);
    expect(database.queries.some(sql => sql.startsWith('CREATE TABLE'))).toBe(false);
    expect(database.closed - beforeClose).toBe(2);
    database.grants = { safe_login: true, no_elevated_membership: true, no_other_role_membership: true,
      no_parameter_admin: true, can_connect: true,
      no_database_create: true, can_use_schema: true, can_create_probe_table: true,
      no_other_schema_create: true, no_other_table_access: true,
      no_sequence_access: true, no_other_routine_execute: true, can_execute_distance: true };
    database.failQuery = 'FROM pg_roles';
    beforeClose = database.closed;
    expect((await qualify()).status).toBe(500);
    expect(database.queries.some(sql => sql.startsWith('CREATE TABLE'))).toBe(false);
    expect(database.closed - beforeClose).toBe(2);
  });

  it('rejects hostile reserved relations before reserve, replay or probe writes', async () => {
    for (const [field, value] of [
      ['relationKind', 'v'], ['relationOwner', 'other_owner'], ['relationColumnsValid', false],
      ['relationSchema', 'other_probe'], ['relationTriggers', 1]
    ] as const) {
      const previous = database[field];
      database[field] = value as never;
      for (const path of ['/qualify/reserve', '/qualify/start', '/qualify']) {
        database.queries = [];
        expect((await qualify('Bearer disposable-token', '1', {}, path)).status).toBe(500);
        expect(database.queries.some(sql => sql.startsWith('CREATE TABLE') || sql.startsWith('INSERT INTO'))).toBe(false);
        expect(database.row).toBeNull();
      }
      database[field] = previous as never;
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
      database.attemptId = '1';
      database.storedAttemptId = null;
      database.activeAttempt = false;
      expect((await qualify('Bearer disposable-token', '1', { STATEPLANE_PROBE_DATABASE: target }, '/qualify/reserve')).status).toBe(200);
      expect((await qualify('Bearer disposable-token', '1', { STATEPLANE_PROBE_DATABASE: target }, '/qualify/start')).status).toBe(200);
      expect((await qualify('Bearer disposable-token', '1', { STATEPLANE_PROBE_DATABASE: target })).status).toBe(200);
      expect((await qualify('Bearer disposable-token', '1', { STATEPLANE_PROBE_DATABASE: target }, '/qualify/residual')).status).toBe(200);
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
