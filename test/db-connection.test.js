import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { connectionOptions } from '../scripts/db-connection.mjs';
import { localPassword } from '../scripts/local-db-password.mjs';
import { migrationOrder } from '../scripts/migration-order.mjs';

test('external database connections require certificate-verified TLS', () => {
  assert.throws(() => connectionOptions('postgres://user@db.example.test/stateplane', ''), /verify-full/);
  assert.throws(() => connectionOptions('postgres://user@db.example.test/stateplane?sslmode=require', ''), /verify-full/);
  const options = connectionOptions('postgres://user@db.example.test/stateplane?sslmode=verify-full', '');
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, servername: 'db.example.test' });
  assert.ok(!options.connectionString.includes('sslmode='));
  const effective = new pg.Client(options).connectionParameters;
  assert.equal(effective.host, 'db.example.test');
  assert.deepEqual(effective.ssl, options.ssl);
  for (const suffix of ['host=remote.example.test', 'hostaddr=remote.example.test', 'ssl=0',
    'sslcert=x', 'sslkey=x', 'sslrootcert=x', 'port=1234', 'sslmode=require']) {
    assert.throws(() => connectionOptions(`postgres://user@db.example.test/stateplane?sslmode=verify-full&${suffix}`, ''), /not allowed|sslmode/);
  }
  assert.throws(() => connectionOptions('postgres://user@db.example.test/stateplane?sslmode=verify-full&sslmode=disable', ''), /duplicate/);
  assert.throws(() => connectionOptions('postgres://user@localhost/stateplane?host=remote.example.test', ''), /not allowed/);
  assert.throws(() => connectionOptions('postgres://user@localhost/stateplane?%68ost=remote.example.test', ''), /not allowed/);
  const named = new pg.Client(connectionOptions('postgres://user@db.example.test/stateplane?sslmode=verify-full&application_name=stateplane', '')).connectionParameters;
  assert.equal(named.application_name, 'stateplane');
});

test('local database keeps the plaintext loopback bootstrap', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const effective = new pg.Client(connectionOptions(`postgres://user@${host}:55432/stateplane`, '')).connectionParameters;
    assert.equal(effective.ssl, false);
  }
  assert.throws(() => connectionOptions('postgres://user@localhost/stateplane?ssl=0', ''), /not allowed/);
  assert.throws(() => connectionOptions('', ''), /DATABASE_URL is required/);
});

test('private CA is passed to the effective external pg client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stateplane-ca-'));
  try {
    const path = join(directory, 'ca.pem');
    await writeFile(path, 'private-ca\n');
    const effective = new pg.Client(connectionOptions('postgres://user@db.example.test/stateplane?sslmode=verify-full', path)).connectionParameters;
    assert.deepEqual(effective.ssl, { rejectUnauthorized: true, servername: 'db.example.test', ca: 'private-ca\n' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent local bootstrap publishes one complete password', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stateplane-password-'));
  try {
    const values = await Promise.all(Array.from({ length: 32 }, () => localPassword(directory, true)));
    assert.equal(new Set(values).size, 1);
    assert.match(values[0], /^[0-9a-f]{64}$/);
    assert.equal(await readFile(join(directory, '.data/local-db-password'), 'utf8'), `${values[0]}\n`);
    assert.deepEqual(await readdir(join(directory, '.data')), ['local-db-password']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('mixed-width migration prefixes apply in numeric order', () => {
  assert.deepEqual(['10_later.sql', '2_first.sql', '001_base.sql'].sort(migrationOrder), ['001_base.sql', '2_first.sql', '10_later.sql']);
});
