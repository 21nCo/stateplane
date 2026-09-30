import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPgdataPlacement } from '../scripts/topology-sql.mjs';

const mountPath = '/var/lib/postgresql/data';
const proxy = { domain: 'proxy.example', proxyPort: 15555 };
const value = 'postgres://settings_reader:private@proxy.example:15555/probe';
const role = { rolsuper: false, rolcreatedb: false, rolcreaterole: false,
  rolreplication: false, rolbypassrls: false, can_read_settings: true,
  can_create_database: false, can_create_schema: false, can_access_tables: false,
  can_access_sequences: false, can_execute_routines: false, can_access_large_objects: false,
  owns_user_objects: false,
  only_settings_membership: true };

function fixture() {
  const state = { dataDirectory: `${mountPath}/pgdata`, role: structuredClone(role), tablespaces: [],
    queries: [], closed: 0 };
  class Client {
    constructor(options) {
      assert.equal(options.ssl.servername, proxy.domain);
      assert.equal(options.ssl.rejectUnauthorized, true);
      assert.equal(options.ssl.ca, 'approved-ca');
    }
    async connect() {}
    async query(sql) {
      state.queries.push(sql);
      if (sql.includes('FROM pg_roles')) return { rows: [state.role] };
      if (sql.includes('current_database')) return { rows: [{ database: 'probe', role: 'settings_reader' }] };
      if (sql.includes('current_setting')) return { rows: [{ data_directory: state.dataDirectory }] };
      if (sql.includes('FROM pg_tablespace')) return { rows: state.tablespaces };
      throw new Error('unexpected SQL');
    }
    async end() { state.closed++; }
  }
  const options = { label: 'probe', volumeInstance: { mountPath }, mountPath, database: 'probe', proxy,
    ca: 'approved-ca', value, operationalRole: 'probe_writer', ClientType: Client };
  return { state, options };
}

test('placement requires a separate least-privilege settings credential', async () => {
  const { state, options } = fixture();
  await verifyPgdataPlacement(options);
  assert.equal(state.queries.length, 4);
  for (const change of [
    () => { state.dataDirectory = '/tmp/pgdata'; },
    () => { state.dataDirectory = `${mountPath}-old/pgdata`; },
    () => { state.dataDirectory = '/var/lib/postgresql/data/../outside'; },
    () => { state.role = { ...role, rolsuper: true }; },
    () => { state.role = { ...role, only_settings_membership: false }; },
    () => { state.role = { ...role, can_access_tables: true }; },
    () => { state.role = { ...role, can_access_sequences: true }; },
    () => { delete state.role.can_access_sequences; },
    () => { state.role = { ...role, can_execute_routines: true }; },
    () => { delete state.role.can_execute_routines; },
    () => { state.role = { ...role, can_access_large_objects: true }; },
    () => { delete state.role.can_access_large_objects; },
    () => { state.role = { ...role, owns_user_objects: true }; },
    () => { delete state.role.owns_user_objects; },
    () => { state.tablespaces = [{ spcname: 'off_volume', location: '/tmp/storage' }]; }
  ]) {
    state.dataDirectory = `${mountPath}/pgdata`;
    state.role = structuredClone(role);
    state.tablespaces = [];
    change();
    await assert.rejects(verifyPgdataPlacement(options), /PGDATA placement proof failed/);
  }
  await assert.rejects(verifyPgdataPlacement({ ...options, operationalRole: 'settings_reader' }),
    /differs from declared proxy or database/);
  await assert.rejects(verifyPgdataPlacement({ ...options, value: 'postgres://probe_writer:private@proxy.example:15555/probe' }),
    /differs from declared proxy or database/);
  assert.equal(state.closed, 16);
});

test('large-object grants stop every operational and disposable PGDATA proof before storage, including retry', async () => {
  for (const label of ['control', 'ap-southeast', 'us-east', 'eu-west',
    'disposable/development-ap-southeast', 'disposable/development-us-east',
    'disposable/development-eu-west', 'disposable/production-ap-southeast',
    'disposable/production-us-east']) {
    const { state, options } = fixture();
    state.role.can_access_large_objects = true;
    await assert.rejects(verifyPgdataPlacement({ ...options, label }), /PGDATA placement proof failed/);
    assert.equal(state.queries.length, 2, label);
    assert.equal(state.queries.some(sql => sql.includes("current_setting('data_directory')") ||
      sql.includes('FROM pg_tablespace')), false, label);
    state.role.can_access_large_objects = false;
    await verifyPgdataPlacement({ ...options, label });
    state.role.can_access_large_objects = true;
    const beforeRetry = state.queries.length;
    await assert.rejects(verifyPgdataPlacement({ ...options, label }), /PGDATA placement proof failed/);
    assert.equal(state.queries.length - beforeRetry, 2, `${label} retry`);
  }
});

test('owned objects stop operational and disposable PGDATA proof before storage readback', async () => {
  for (const label of ['operational/control', 'disposable/development-apse']) {
    const { state, options } = fixture();
    state.role.owns_user_objects = true;
    await assert.rejects(verifyPgdataPlacement({ ...options, label }), /PGDATA placement proof failed/);
    assert.equal(state.queries.length, 2, label);
    assert.equal(state.queries.some(sql => sql.includes("current_setting('data_directory')") ||
      sql.includes('FROM pg_tablespace')), false,
      `${label} must reject before storage readback`);
    assert.equal(state.closed, 1);
    state.role.owns_user_objects = false;
    await verifyPgdataPlacement({ ...options, label });
    state.role.owns_user_objects = true;
    const beforeRetry = state.queries.length;
    await assert.rejects(verifyPgdataPlacement({ ...options, label }), /PGDATA placement proof failed/);
    assert.equal(state.queries.length - beforeRetry, 2, `${label} restored ownership must block retry`);
  }
});

test('PGDATA proof closes its SQL client on interruption without issuing a query', async () => {
  const controller = new AbortController();
  let closed = false;
  let queried = false;
  class Client {
    async connect() { controller.abort(); }
    async query() { queried = true; return { rows: [] }; }
    async end() { closed = true; }
  }
  const { options } = fixture();
  await assert.rejects(verifyPgdataPlacement({ ...options, ClientType: Client,
    signal: controller.signal }), /topology verification interrupted/);
  assert.equal(queried, false);
  assert.equal(closed, true);
});
