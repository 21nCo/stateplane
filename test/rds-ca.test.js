import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectRdsRoot, assertUploadedRdsRoot } from '../scripts/rds-ca.mjs';

const bundle = readFileSync(new URL('./fixtures/rds-us-east-1-roots.pem', import.meta.url), 'utf8');

test('selects one root for the instance CA and rejects a different or bundled upload', () => {
  const rsa2048 = selectRdsRoot(bundle, 'us-east-1', 'rds-ca-rsa2048-g1');
  const rsa4096 = selectRdsRoot(bundle, 'us-east-1', 'rds-ca-rsa4096-g1');
  assert.notEqual(rsa2048.fingerprint256, rsa4096.fingerprint256);
  assert.doesNotThrow(() => assertUploadedRdsRoot({ ca: true, certificates: rsa2048.pem }, rsa2048));
  assert.throws(() => assertUploadedRdsRoot({ ca: true, certificates: rsa4096.pem }, rsa2048), /does not match/);
  assert.throws(() => assertUploadedRdsRoot({ ca: true, certificates: bundle }, rsa2048), /does not match/);
  assert.throws(() => assertUploadedRdsRoot({ ca: false, certificates: rsa2048.pem }, rsa2048), /unavailable/);
  assert.throws(() => selectRdsRoot(bundle, 'eu-west-1', 'rds-ca-rsa2048-g1'), /unavailable/);
  assert.throws(() => selectRdsRoot(bundle, 'us-east-1', 'rds-ca-ecc384-g1'), /unavailable/);
});
