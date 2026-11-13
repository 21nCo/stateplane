import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// STA-76: the published export manifest schema compiles under JSON Schema 2020-12 with ajv-formats' date-time
// format, accepts a well-formed version 1 manifest and refuses a malformed one. The verifier and its full case list
// land with STA-77 (test/portability-manifest.test.js). strict:false, as there: strict mode refuses the open-ended
// prefixItems tuple of the eleven evidence sections.
const schema = JSON.parse(await readFile(new URL('../contracts/portability-manifest.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const valid = ajv.compile(schema);

const sections = ['permissions', 'schemas', 'retrieval', 'sources', 'extractions', 'claims', 'provenance', 'links',
  'events', 'records', 'revisions'];
const sha = 'a'.repeat(64);
function manifest() {
  return { format: 'stateplane.space-export', formatVersion: 1, jobId: 'exp_00000000-0000-4000-8000-000000000000',
    space: { spaceId: 'sp_1', ownerPrincipalId: 'usr_1', policyVersion: 1, placementGeneration: 1 },
    boundary: { watermark: 0, snapshotAt: '2026-11-13T01:02:03.123456Z', records: 'as-of-watermark', evidence: 'as-of-snapshot' },
    sections: sections.map(name => ({ name, rows: name === 'schemas' ? 1 : 0, bytes: name === 'schemas' ? 37 : 0,
      accelerator: false })),
    parts: [{ number: 1, section: 'schemas', rows: 1, bytes: 37, sha256: sha }],
    excluded: ['credential-secrets'] };
}

test('the manifest schema accepts a well-formed version 1 manifest', () => {
  assert.ok(valid(manifest()), JSON.stringify(valid.errors));
  // snapshotAt accepts what its description states: T or t, Z or z, or a +HH:MM or -HH:MM offset.
  for (const snapshotAt of ['2026-11-13t01:02:03.123456z', '2026-11-13T01:02:03-05:00', '2026-11-13T01:02:03+05:30']) {
    const value = manifest();
    value.boundary.snapshotAt = snapshotAt;
    assert.ok(valid(value), `${snapshotAt}: ${JSON.stringify(valid.errors)}`);
  }
});

test('the pattern checks date fields by range only; ajv-formats refuses a day its month lacks', () => {
  for (const [snapshotAt, accepted] of [['2026-02-31T01:02:03Z', false], ['2025-02-29T01:02:03Z', false],
    ['2024-02-29T01:02:03Z', true]]) {
    const value = manifest();
    value.boundary.snapshotAt = snapshotAt;
    assert.equal(valid(value), accepted, snapshotAt);
    // Without a date-time format assertion the pattern alone accepts all three.
    assert.ok(new RegExp(schema.$defs.rfc3339.pattern).test(snapshotAt), snapshotAt);
  }
});

test('the manifest schema refuses a malformed manifest', () => {
  const cases = {
    'missing jobId': m => { delete m.jobId; },
    'an extra top-level member': m => { m.secret = 'x'; },
    'another format version': m => { m.formatVersion = 2; },
    'sections reordered': m => { m.sections.reverse(); },
    'a leap second instant': m => { m.boundary.snapshotAt = '2016-12-31T23:59:60Z'; },
    'a part of 0 bytes': m => { m.parts[0].bytes = 0; }
  };
  for (const [name, change] of Object.entries(cases)) {
    const value = manifest();
    change(value);
    assert.equal(valid(value), false, name);
  }
});

test('a section line envelope is closed while its canonical JSON data is not inspected', () => {
  const record = ajv.getSchema(`${schema.$id}#/$defs/records`);
  const line = () => ({ collectionId: 'col_1', id: 'rec_1', keyMode: 'generated', key: 'rec_1', revision: 1,
    schemaVersion: 1, data: { sessionToken: 'user content as stored' } });
  assert.ok(record(line()), JSON.stringify(record.errors));
  const extra = line();
  extra.sessionToken = 'x';
  assert.equal(record(extra), false);
});
