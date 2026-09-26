import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { connectionOptions } from '../scripts/db-connection.mjs';
import { migrationOrder } from '../scripts/migration-order.mjs';

test('external database connections require certificate-verified TLS', () => {
  assert.throws(() => connectionOptions('postgres://user:secret@db.example.test/stateplane', ''), /verify-full/);
  assert.throws(() => connectionOptions('postgres://user:secret@db.example.test/stateplane?sslmode=require', ''), /verify-full/);
  const options = connectionOptions('postgres://user:secret@db.example.test/stateplane?sslmode=verify-full', '');
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, servername: 'db.example.test' });
  assert.ok(!options.connectionString.includes('sslmode='));
});

test('local database keeps the plaintext loopback bootstrap', () => {
  assert.equal(connectionOptions('postgres://user:secret@127.0.0.1:55432/stateplane', '').ssl, undefined);
  assert.throws(() => connectionOptions('', ''), /DATABASE_URL is required/);
});

test('mixed-width migration prefixes apply in numeric order', () => {
  assert.deepEqual(['10_later.sql', '2_first.sql', '001_base.sql'].sort(migrationOrder), ['001_base.sql', '2_first.sql', '10_later.sql']);
});
