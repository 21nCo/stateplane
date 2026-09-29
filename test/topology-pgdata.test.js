import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPgdataPlacement, verifyRailwayStoragePaths } from '../scripts/topology-sql.mjs';

const mountPath = '/var/lib/postgresql/data';
const proxy = { domain: 'proxy.example', proxyPort: 15555 };
const value = 'postgres://settings_reader:private@proxy.example:15555/probe';
const id = '11111111-1111-4111-8111-111111111111';
const role = { rolsuper: false, rolcreatedb: false, rolcreaterole: false,
  rolreplication: false, rolbypassrls: false, can_read_settings: true,
  can_create_database: false, can_create_schema: false, can_access_tables: false,
  can_access_sequences: false, can_execute_routines: false,
  only_settings_membership: true };

function fixture() {
  const state = { dataDirectory: `${mountPath}/pgdata`, role: structuredClone(role), tablespaces: [],
    queries: [], closed: 0, storage: [] };
  class Client {
    constructor(options) {
      assert.equal(options.ssl.servername, proxy.domain);
      assert.equal(options.ssl.rejectUnauthorized, true);
      assert.equal(options.ssl.ca, 'approved-ca');
    }
    async connect() {}
    async query(sql) {
      state.queries.push(sql);
      if (sql.includes('current_setting')) return { rows: [{ database: 'probe', role: 'settings_reader', data_directory: state.dataDirectory }] };
      if (sql.includes('FROM pg_roles')) return { rows: [state.role] };
      if (sql.includes('FROM pg_tablespace')) return { rows: state.tablespaces };
      throw new Error('unexpected SQL');
    }
    async end() { state.closed++; }
  }
  const options = { label: 'probe', volumeInstance: { mountPath }, mountPath, database: 'probe', proxy,
    ca: 'approved-ca', value, operationalRole: 'probe_writer', projectId: id, environmentId: id,
    serviceId: id, ClientType: Client, verifyStorage: async input => { state.storage.push(input); } };
  return { state, options };
}

test('both placement paths require a separate least-privilege settings credential before storage proof', async () => {
  const { state, options } = fixture();
  await verifyPgdataPlacement(options);
  assert.equal(state.storage.length, 1);
  assert.equal(state.storage[0].dataDirectory, `${mountPath}/pgdata`);
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
    () => { state.tablespaces = [{ spcname: 'off_volume', location: '/tmp/storage' }]; }
  ]) {
    state.dataDirectory = `${mountPath}/pgdata`;
    state.role = structuredClone(role);
    state.tablespaces = [];
    change();
    await assert.rejects(verifyPgdataPlacement(options), /PGDATA placement proof failed/);
  }
  assert.equal(state.storage.length, 1, 'unsafe SQL result must block before container inspection');
  await assert.rejects(verifyPgdataPlacement({ ...options, operationalRole: 'settings_reader' }),
    /differs from declared proxy or database/);
  await assert.rejects(verifyPgdataPlacement({ ...options, value: 'postgres://probe_writer:private@proxy.example:15555/probe' }),
    /differs from declared proxy or database/);
  assert.equal(state.closed, 12);
});

test('running container WAL path must resolve inside the approved volume and have no user tablespace', async () => {
  const calls = [];
  const options = { label: 'probe', projectId: id, environmentId: id, serviceId: id,
    dataDirectory: `${mountPath}/pgdata`, mountPath,
    runCommand: async (command, args, config) => {
      calls.push({ command, args, config });
      return { stdout: `${mountPath}/pgdata\n/tmp/wal\n` };
    } };
  await assert.rejects(verifyRailwayStoragePaths(options), /WAL, tablespace or data path/);
  assert.equal(calls[0].command, 'railway');
  assert.deepEqual(calls[0].args.slice(0, 9), ['ssh', '--project', id, '--service', id, '--environment', id, '--', 'sh']);
  assert.equal(calls[0].config.timeout, 15_000);
  await verifyRailwayStoragePaths({ ...options, runCommand: async () =>
    ({ stdout: `${mountPath}/pgdata\n${mountPath}/pgdata/pg_wal\n` }) });
  await assert.rejects(verifyRailwayStoragePaths({ ...options, runCommand: async () =>
    ({ stdout: `${mountPath}/pgdata\n${mountPath}/pgdata/pg_wal\n${mountPath}/pgdata/pg_tblspc/123\n` }) }),
  /WAL, tablespace or data path/);
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
