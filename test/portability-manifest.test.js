import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { exportSections, verifyExportManifest } from '../packages/contracts/dist/index.js';

// STA-70: verifyExportManifest accepts exactly the manifests the published JSON Schema accepts (plus the rules the
// schema cannot state), even when the manifest's digest is correct: a digest proves the bytes, not the format.
const schema = JSON.parse(await readFile(new URL('../contracts/portability-manifest.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const valid = ajv.compile(schema);
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

const content = '{"collectionId":"alpha","version":1}\n';
function manifest() {
  return { format: 'stateplane.space-export', formatVersion: 1, jobId: 'exp_00000000-0000-4000-8000-000000000000',
    space: { spaceId: 'sp_1', ownerPrincipalId: 'usr_1', policyVersion: 1, placementGeneration: 1 },
    boundary: { watermark: 0, snapshotAt: '2026-11-13T01:02:03.123456Z', records: 'as-of-watermark', evidence: 'as-of-snapshot' },
    sections: exportSections.map(name => ({ name, rows: name === 'schemas' ? 1 : 0, bytes: name === 'schemas' ? content.length : 0,
      accelerator: false })),
    parts: [{ number: 1, section: 'schemas', rows: 1, bytes: content.length, sha256: sha(content) }],
    excluded: ['credential-secrets'] };
}
/** The manifest re-sealed: its own correct digest. */
const sealed = value => { const text = JSON.stringify(value); return [text, sha(text)]; };
const edit = change => { const value = manifest(); change(value); return value; };

test('a well-formed manifest verifies and matches the schema', async () => {
  const value = manifest();
  assert.ok(valid(value), JSON.stringify(valid.errors));
  const [text, digest] = sealed(value);
  assert.deepEqual(await verifyExportManifest(text, digest, [content]), { ok: true, manifest: value });
});

test('every RFC 3339 instant the schema accepts verifies, leap days and leap seconds included', async () => {
  for (const instant of ['2024-02-29T00:00:00Z', '2000-02-29T23:59:59.999999Z', '2016-12-31T23:59:60Z',
    '2017-01-01T00:59:60+01:00', '2026-11-13T01:02:03.5-05:30']) {
    const value = edit(m => { m.boundary.snapshotAt = instant; });
    assert.ok(valid(value), `the schema refuses ${instant}`);
    const [text, digest] = sealed(value);
    assert.equal((await verifyExportManifest(text, digest)).ok, true, `the verifier refuses ${instant}`);
  }
});

test('a correctly hashed manifest the schema refuses is refused, whatever member is wrong', async () => {
  const many = Array.from({ length: 4_096 }, (_, i) => ({ number: i + 1, section: 'schemas', rows: 0, bytes: 1, sha256: sha('x') }));
  const cases = {
    'missing jobId': m => { delete m.jobId; },
    'missing space': m => { delete m.space; },
    'missing excluded': m => { delete m.excluded; },
    'an extra top-level member': m => { m.secret = 'x'; },
    'an extra space member': m => { m.space.token = 'x'; },
    'an extra boundary member': m => { m.boundary.extra = 1; },
    'an extra section member': m => { m.sections[0].extra = 1; },
    'an extra part member': m => { m.parts[0].objectKey = 'k'; },
    'a malformed jobId': m => { m.jobId = 'job-1'; },
    'an empty spaceId': m => { m.space.spaceId = ''; },
    'a zero policy version': m => { m.space.policyVersion = 0; },
    'a fractional placement generation': m => { m.space.placementGeneration = 1.5; },
    'a non-string excluded item': m => { m.excluded = [1]; },
    'a snapshot instant that is not a date-time': m => { m.boundary.snapshotAt = 'yesterday'; },
    'a snapshot instant on a day its month lacks': m => { m.boundary.snapshotAt = '2026-02-30T01:02:03Z'; },
    'a snapshot instant on 29 February of a common year': m => { m.boundary.snapshotAt = '2100-02-29T01:02:03Z'; },
    'a snapshot instant in month 13': m => { m.boundary.snapshotAt = '2026-13-01T01:02:03Z'; },
    'a snapshot instant at hour 24': m => { m.boundary.snapshotAt = '2026-11-13T24:00:00Z'; },
    'a snapshot instant at minute 60': m => { m.boundary.snapshotAt = '2026-11-13T01:60:00Z'; },
    'a snapshot instant with a second of 60 that is no leap second': m => { m.boundary.snapshotAt = '2026-11-13T01:02:60Z'; },
    'a snapshot instant with an offset of 24 hours': m => { m.boundary.snapshotAt = '2026-11-13T01:02:03+24:00'; },
    'a part of zero bytes': m => { m.parts[0].bytes = 0; m.sections[1].bytes = 0; },
    'a part over 1 MiB': m => { m.parts[0].bytes = 1_048_577; m.sections[1].bytes = 1_048_577; },
    'a non-boolean accelerator': m => { m.sections[0].accelerator = 0; },
    'more than 4,095 data parts': m => { m.parts = many; m.sections[1].rows = 0; m.sections[1].bytes = many.length; }
  };
  for (const [label, change] of Object.entries(cases)) {
    const value = edit(change);
    // The schema itself refuses each (snapshotAt by its date-time format).
    assert.equal(valid(value), false, `the schema accepts ${label}`);
    const [text, digest] = sealed(value);
    const verdict = await verifyExportManifest(text, digest);
    assert.equal(verdict.ok, false, `the verifier accepts ${label}`);
  }
});

test('the rules the schema cannot state are refused too', async () => {
  const cases = {
    'a gap in part numbers': m => { m.parts[0].number = 2; },
    'sections out of order': m => { [m.sections[0], m.sections[1]] = [m.sections[1], m.sections[0]]; },
    'an evidence section missing': m => { m.sections.pop(); },
    'a section that does not total its parts': m => { m.sections[1].rows = 2; },
    'embeddings not marked as an accelerator': m => { m.sections.push({ name: 'embeddings', rows: 0, bytes: 0, accelerator: false }); }
  };
  for (const [label, change] of Object.entries(cases)) {
    const [text, digest] = sealed(edit(change));
    assert.equal((await verifyExportManifest(text, digest)).ok, false, `the verifier accepts ${label}`);
  }
});
