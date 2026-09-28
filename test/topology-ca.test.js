import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUploadedCa } from '../scripts/topology-ca.mjs';

const pem = readFileSync(new URL('./fixtures/sta4-ca-certificate.txt', import.meta.url), 'utf8').trim();
const id = 'abcdefab-1111-4111-8111-abcdefabcdef';
const response = certificates => ({ success: true, result: { id, ca: true, certificates } });
const duringValidity = Date.parse('2027-01-01T00:00:00Z');

test('Cloudflare CA readback accepts one real multiline certificate', () => {
  assert.equal(parseUploadedCa(response(`${pem}\n`), id.toUpperCase(), duringValidity), pem);
});

test('Cloudflare CA readback rejects invalid, multiple, expired and unrelated certificates', () => {
  assert.throws(() => parseUploadedCa(response(pem), '11111111-1111-4111-8111-111111111111', duringValidity), /unavailable/);
  assert.throws(() => parseUploadedCa({ ...response(pem), result: { id, ca: false, certificates: pem } }, id, duringValidity), /unavailable/);
  assert.throws(() => parseUploadedCa(response('not a certificate'), id, duringValidity), /one unexpired/);
  assert.throws(() => parseUploadedCa(response('-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----'), id, duringValidity), /one unexpired/);
  assert.throws(() => parseUploadedCa(response(`${pem}\n${pem}`), id, duringValidity), /one unexpired/);
  assert.throws(() => parseUploadedCa(response(`unrelated\n${pem}`), id, duringValidity), /one unexpired/);
  assert.throws(() => parseUploadedCa(response(pem), id, Date.parse('2040-01-01T00:00:00Z')), /one unexpired/);
  assert.throws(() => parseUploadedCa(response(pem), id, Date.parse('2020-01-01T00:00:00Z')), /one unexpired/);
});
