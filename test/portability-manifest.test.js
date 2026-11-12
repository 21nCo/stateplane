import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { exportSections, verifyExportManifest } from '../packages/contracts/dist/index.js';

// STA-70: verifyExportManifest accepts exactly the manifests the published JSON Schema accepts (plus the rules the
// schema cannot state), even when the manifest's digest is correct: a digest proves the bytes, not the format.
const schema = JSON.parse(await readFile(new URL('../contracts/portability-manifest.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
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
    'a part of zero bytes': m => { m.parts[0].bytes = 0; m.sections[1].bytes = 0; },
    'a part over 1 MiB': m => { m.parts[0].bytes = 1_048_577; m.sections[1].bytes = 1_048_577; },
    'a non-boolean accelerator': m => { m.sections[0].accelerator = 0; },
    'more than 4,095 data parts': m => { m.parts = many; m.sections[1].rows = 0; m.sections[1].bytes = many.length; }
  };
  for (const [label, change] of Object.entries(cases)) {
    const value = edit(change);
    // The schema itself refuses each (snapshotAt by its date-time format, which this validator leaves unchecked).
    if (label !== 'a snapshot instant that is not a date-time') assert.equal(valid(value), false, `the schema accepts ${label}`);
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
