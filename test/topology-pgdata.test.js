import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPgdataPlacement } from '../scripts/topology-sql.mjs';

const mountPath = '/var/lib/postgresql/data';
const proxy = { domain: 'proxy.example', proxyPort: 15555 };
const value = 'postgres://settings_reader:private@proxy.example:15555/probe';

test('running PostgreSQL data_directory must be within the independently inventoried Railway mount', async () => {
  let dataDirectory = `${mountPath}/pgdata`;
  let closed = 0;
  class Client {
    constructor(options) {
      assert.equal(options.ssl.servername, proxy.domain);
      assert.equal(options.ssl.rejectUnauthorized, true);
      assert.equal(options.ssl.ca, 'approved-ca');
    }
    async connect() {}
    async query(sql) {
      assert.match(sql, /current_setting\('data_directory'\)/);
      return { rows: [{ database: 'probe', role: 'settings_reader', data_directory: dataDirectory }] };
    }
    async end() { closed++; }
  }
  const options = { label: 'probe', volumeInstance: { mountPath }, mountPath,
    database: 'probe', proxy, ca: 'approved-ca', value, ClientType: Client };
  await verifyPgdataPlacement(options);
  for (dataDirectory of ['/tmp/pgdata', `${mountPath}-old/pgdata`, '/var/lib/postgresql/data/../outside']) {
    await assert.rejects(verifyPgdataPlacement(options), /PGDATA placement proof failed/);
  }
  dataDirectory = `${mountPath}/pgdata`;
  await assert.rejects(verifyPgdataPlacement({ ...options, volumeInstance: {} }), /PGDATA placement proof failed/);
  await assert.rejects(verifyPgdataPlacement({ ...options, mountPath: '/other' }), /PGDATA placement proof failed/);
  assert.equal(closed, 6);
});

test('PGDATA proof closes its SQL client on interruption and cannot authorize a Preview', async () => {
  const controller = new AbortController();
  let closed = false;
  class Client {
    async connect() { controller.abort(); }
    async query() { throw new Error('query must not run'); }
    async end() { closed = true; }
  }
  await assert.rejects(verifyPgdataPlacement({ label: 'probe', volumeInstance: { mountPath }, mountPath,
    database: 'probe', proxy, ca: 'approved-ca', value, ClientType: Client,
    signal: controller.signal }), /topology verification interrupted/);
  assert.equal(closed, true);
});
