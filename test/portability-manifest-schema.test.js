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

// Each section line admits only what its authority columns can hold (migrations 002, 040, 042, 045): null only
// where the column is, digests as digests, CHECK lists as enums, predecessors null or at least 1, and the row rules
// of originals, reviews and vector retrieval.
const t = '2026-11-13T01:02:03.123456Z';
const lines = {
  retrieval: () => ({ collectionId: 'col_1', version: 1, previousVersion: null, recordFields: [], sourceContent: false,
    claimStatements: false, lexical: true, vector: false, textSearchConfig: 'simple', processingRegions: [],
    credentialId: 'cred_1', createdAt: t }),
  sources: () => ({ collectionId: 'col_1', sourceId: 'src_1', kind: 'source', locator: null, principalId: 'usr_1',
    credentialId: 'cred_1', createdAt: t, original: { referenceOnly: false, sha256: sha, byteSize: 3, mimeType: 'text/plain',
      capturedAt: t, observedAt: t } }),
  extractions: () => ({ collectionId: 'col_1', sourceId: 'src_1', version: 1, previousVersion: null, sourceSha256: sha,
    parser: 'text', parserVersion: '1', credentialId: 'cred_1', createdAt: t, content: 'abc', sourceOffsets: [] }),
  claims: () => ({ collectionId: 'col_1', claimId: 'clm_1', revision: 1, kind: 'claim', principalId: 'usr_1', createdAt: t,
    previousRevision: null, statement: 'a', attributedTo: 'usr_1', credentialId: 'cred_1', recordedBy: 'usr_1',
    observedAt: null, validFrom: null, validUntil: null, reviewStatus: 'unreviewed', reviewedBy: null, reviewedAt: null,
    committedAt: t }),
  links: () => ({ collectionId: 'col_1', linkId: 'lnk_1', revision: 1, linkType: 'cites', deletionPolicy: 'restrict',
    from: { kind: 'claim', collectionId: 'col_1', id: 'clm_1' }, to: { kind: 'source', collectionId: 'col_1', id: 'src_1' },
    credentialId: 'cred_1', createdAt: t }),
  revisions: () => ({ collectionId: 'col_1', id: 'rec_1', keyMode: 'generated', key: 'rec_1', revision: 1, eventId: 'evt_1',
    position: 1, operation: 'create', schemaVersion: 1, credentialId: 'cred_1', committedAt: t, data: {} }),
  events: () => ({ eventId: 'eev_1', collectionId: 'col_1', kind: 'link', entityId: 'lnk_1', revision: 1,
    operation: 'create', credentialId: 'cred_1', committedAt: t }),
  permissions: () => ({ credentialId: 'cred_1', principalId: 'usr_1', createdAt: t, expiresAt: t, activatedAt: null,
    confirmedAt: null, revokedAt: null, grants: [{ collectionId: 'col_1', capabilities: ['records:read'], expiresAt: null }] })
};
const section = name => ajv.getSchema(`${schema.$id}#/$defs/${name}`);

test('section lines the authority stores are accepted', () => {
  const accepted = {
    'version 1 with null predecessors': [['retrieval', () => {}], ['extractions', () => {}], ['claims', () => {}]],
    'a later version naming its predecessor': [['retrieval', l => { l.version = 2; l.previousVersion = 1; }],
      ['extractions', l => { l.version = 2; l.previousVersion = 1; }], ['claims', l => { l.revision = 2; l.previousRevision = 1; }]],
    'a reference-only original': [['sources', l => {
      l.locator = 'https://example.com/a';
      l.original = { referenceOnly: true, sha256: null, byteSize: null, mimeType: null, capturedAt: t, observedAt: t };
    }]],
    'an accepted claim with its reviewer': [['claims', l => {
      Object.assign(l, { reviewStatus: 'accepted', reviewedBy: 'usr_1', reviewedAt: t });
    }]],
    'a pre-042 revision without a recorder': [['claims', l => { l.recordedBy = null; }]],
    'vector retrieval with a region': [['retrieval', l => { l.vector = true; l.processingRegions = ['eu-west-1']; }]],
    'record fields as JSON Pointers': [['retrieval', l => { l.recordFields = ['/title', '/a~1b/0']; }]],
    'a deletion revision': [['revisions', l => { l.operation = 'delete'; l.data = null; }]]
  };
  for (const [name, changes] of Object.entries(accepted)) {
    for (const [kind, change] of changes) {
      const line = lines[kind]();
      change(line);
      assert.ok(section(kind)(line), `${name} (${kind}): ${JSON.stringify(section(kind).errors)}`);
    }
  }
});

test('section lines the authority refuses are refused', () => {
  const refused = {
    'a predecessor of 0': ['extractions', l => { l.version = 2; l.previousVersion = 0; }],
    'a negative predecessor': ['retrieval', l => { l.version = 2; l.previousVersion = -1; }],
    'a predecessor at version 1': ['retrieval', l => { l.previousVersion = 1; }],
    'no predecessor after version 1': ['retrieval', l => { l.version = 2; }],
    'an extraction predecessor at version 1': ['extractions', l => { l.previousVersion = 1; }],
    'no extraction predecessor after version 1': ['extractions', l => { l.version = 3; }],
    'a claim predecessor at revision 1': ['claims', l => { l.previousRevision = 1; }],
    'no claim predecessor after revision 1': ['claims', l => { l.revision = 2; }],
    'a claim predecessor of 0': ['claims', l => { l.revision = 2; l.previousRevision = 0; }],
    'a null extraction digest': ['extractions', l => { l.sourceSha256 = null; }],
    'a malformed extraction digest': ['extractions', l => { l.sourceSha256 = 'A'.repeat(64); }],
    'a null parser': ['extractions', l => { l.parser = null; }],
    'a null parser version': ['extractions', l => { l.parserVersion = null; }],
    'a null extraction credential': ['extractions', l => { l.credentialId = null; }],
    'a null claim kind': ['claims', l => { l.kind = null; }],
    'a null claim principal': ['claims', l => { l.principalId = null; }],
    'a null statement': ['claims', l => { l.statement = null; }],
    'a null attribution': ['claims', l => { l.attributedTo = null; }],
    'a null claim credential': ['claims', l => { l.credentialId = null; }],
    'an empty recorder': ['claims', l => { l.recordedBy = ''; }],
    'an empty locator': ['sources', l => { l.locator = ''; }],
    'an empty event credential': ['events', l => { l.credentialId = ''; }],
    'a record field that is not a JSON Pointer': ['retrieval', l => { l.recordFields = ['title']; }],
    'a repeated record field': ['retrieval', l => { l.recordFields = ['/a', '/a']; }],
    'an uppercase region': ['retrieval', l => { l.processingRegions = ['EU']; }],
    'a repeated region': ['retrieval', l => { l.processingRegions = ['eu', 'eu']; }],
    'seventeen regions': ['retrieval', l => { l.processingRegions = Array.from({ length: 17 }, (_, i) => `r${i}`); }],
    'an unknown review status': ['claims', l => { l.reviewStatus = 'maybe'; }],
    'a null review status': ['claims', l => { l.reviewStatus = null; }],
    'an accepted claim without a reviewer': ['claims', l => { l.reviewStatus = 'accepted'; }],
    'an unreviewed claim with a reviewer': ['claims', l => { l.reviewedBy = 'usr_1'; l.reviewedAt = t; }],
    'an unknown record operation': ['revisions', l => { l.operation = 'upsert'; }],
    'a null revision credential': ['revisions', l => { l.credentialId = null; }],
    'a null source principal': ['sources', l => { l.principalId = null; }],
    'a null source credential': ['sources', l => { l.credentialId = null; }],
    'another source kind': ['sources', l => { l.kind = 'claim'; }],
    'a stored original without a digest': ['sources', l => { l.original.sha256 = null; }],
    'a stored original without a size': ['sources', l => { l.original.byteSize = null; }],
    'a stored original without a type': ['sources', l => { l.original.mimeType = null; }],
    'a reference-only original with a digest': ['sources', l => { l.original.referenceOnly = true; }],
    'an original without a capture time': ['sources', l => { l.original.capturedAt = null; }],
    'an original without an observation time': ['sources', l => { l.original.observedAt = null; }],
    'a null retrieval credential': ['retrieval', l => { l.credentialId = null; }],
    'a null text search configuration': ['retrieval', l => { l.textSearchConfig = null; }],
    'null processing regions': ['retrieval', l => { l.processingRegions = null; }],
    'vector retrieval without a region': ['retrieval', l => { l.vector = true; }],
    'an unknown deletion policy': ['links', l => { l.deletionPolicy = 'cascade'; }],
    'an unknown endpoint kind': ['links', l => { l.to.kind = 'space'; }],
    'a null link credential': ['links', l => { l.credentialId = null; }],
    'an unknown capability': ['permissions', l => { l.grants[0].capabilities = ['records:admin']; }]
  };
  for (const [name, [kind, change]] of Object.entries(refused)) {
    const line = lines[kind]();
    assert.ok(section(kind)(line), `${kind} baseline: ${JSON.stringify(section(kind).errors)}`);
    change(line);
    assert.equal(section(kind)(line), false, name);
  }
});

test('an embeddings part needs the embeddings section', () => {
  const embeddingsPart = m => m.parts.push({ number: 2, section: 'embeddings', rows: 1, bytes: 10, sha256: sha });
  const embeddingsSection = m => m.sections.push({ name: 'embeddings', rows: 1, bytes: 10, accelerator: true });
  const without = manifest();
  assert.ok(valid(without), JSON.stringify(valid.errors));
  embeddingsPart(without);
  assert.equal(valid(without), false, 'an embeddings part without the section');
  const withSection = manifest();
  embeddingsSection(withSection);
  assert.ok(valid(withSection), JSON.stringify(valid.errors));
  embeddingsPart(withSection);
  assert.ok(valid(withSection), JSON.stringify(valid.errors));
});
