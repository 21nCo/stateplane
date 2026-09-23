import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const example = JSON.parse(read('contracts/examples/entries.v1.json'));

test('published generic example uses closed Draft 2020-12 object syntax', () => {
  assert.equal(example.version, 1);
  assert.equal(example.schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(example.schema.type, 'object');
  assert.equal(example.schema.additionalProperties, false);
  assert.deepEqual(example.schema.required, ['label']);
  assert.deepEqual(example.unique, [{ name: 'by_label', paths: ['label'] }]);
  for (const path of [...example.unique[0].paths, ...example.filterable, ...example.sortable]) {
    assert.ok(Object.hasOwn(example.schema.properties, path), `undeclared path ${path}`);
  }
});

test('unique comparison normalizes only the index key, not stored data', () => {
  const composed = '\u00e9';
  const decomposed = 'e\u0301';
  assert.notEqual(composed, decomposed);
  assert.equal(composed.normalize('NFC'), decomposed.normalize('NFC'));
  assert.match(read('contracts/v1.md'), /For composite \*comparison only\*.*normalized to Unicode NFC.*stored record values remain byte-for-byte/s);
  assert.match(read('contracts/decisions.md'), /normalization boundary is the reservation, not the record/);
});

test('architecture and foundation agree on space and regional authority', () => {
  const architecture = read('ARCHITECTURE.md');
  const contract = read('contracts/v1.md');
  assert.match(architecture, /Postgres authority/);
  assert.match(architecture, /cache-disabled Hyperdrive/);
  assert.match(architecture, /pgvector/);
  assert.match(contract, /ownerPrincipalId, homeCellId/);
  assert.match(contract, /storageTargetId, generation/);
  assert.match(contract, /policyVersion/);
  assert.doesNotMatch(architecture, /Turso Cloud|recommend Mem0|Supermemory as a projection/);
});
