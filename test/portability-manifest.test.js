import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { exportSections, verifyExportManifest } from '../packages/contracts/dist/index.js';

// STA-70: verifyExportManifest refuses every manifest the published JSON Schema refuses (plus the rules the schema
// cannot state), even when the manifest's digest is correct: a digest proves the bytes, not the format. The schema is
// checked with ajv-formats' date-time format and its own instant pattern; the pattern refuses what ajv-formats alone
// accepts (any leap second, as version 1 carries none, a space separator, an offset without a colon), so both accept
// the same instants.
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

test('every RFC 3339 instant the schema accepts verifies, leap days included', async () => {
  for (const instant of ['2024-02-29T00:00:00Z', '2000-02-29T23:59:59.999999Z', '2017-01-01T00:59:59+01:00',
    '2026-11-13T01:02:03.5-05:30']) {
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
    'a leap second at local hour 24': m => { m.boundary.snapshotAt = '2026-11-13T24:59:60+01:00'; },
    'a leap second at minute 99': m => { m.boundary.snapshotAt = '2026-11-13T23:99:60+00:40'; },
    // Version 1 carries no leap second at all, announced or not, in UTC or across a UTC date by its offset.
    'an announced leap second': m => { m.boundary.snapshotAt = '2016-12-31T23:59:60Z'; },
    'an unannounced leap second': m => { m.boundary.snapshotAt = '2025-01-01T23:59:60Z'; },
    'a leap second whose offset crosses the UTC date': m => { m.boundary.snapshotAt = '2017-01-01T00:59:60+01:00'; },
    'a snapshot instant with a space separator': m => { m.boundary.snapshotAt = '2026-11-13 01:02:03Z'; },
    'a snapshot instant with an offset without a colon': m => { m.boundary.snapshotAt = '2026-11-13T01:02:03+0100'; },
    'a snapshot instant with an hour-only offset': m => { m.boundary.snapshotAt = '2026-11-13T01:02:03+01'; },
    'a part of zero bytes': m => { m.parts[0].bytes = 0; m.sections[1].bytes = 0; },
    'a part over 1 MiB': m => { m.parts[0].bytes = 1_048_577; m.sections[1].bytes = 1_048_577; },
    'a non-boolean accelerator': m => { m.sections[0].accelerator = 0; },
    'more than 4,095 data parts': m => { m.parts = many; m.sections[1].rows = 0; m.sections[1].bytes = many.length; }
  };
  for (const [label, change] of Object.entries(cases)) {
    const value = edit(change);
    // The schema itself refuses each (snapshotAt by its date-time format or its pattern).
    assert.equal(valid(value), false, `the schema accepts ${label}`);
    const [text, digest] = sealed(value);
    const verdict = await verifyExportManifest(text, digest);
    assert.equal(verdict.ok, false, `the verifier accepts ${label}`);
  }
});

test('the instant pattern refuses what the date-time format alone accepts', () => {
  // Pins why the schema carries a pattern: ajv-formats alone accepts these, the schema and the verifier do not.
  const format = new Ajv2020({ strict: false });
  addFormats(format);
  const dateTime = format.compile({ type: 'string', format: 'date-time' });
  for (const instant of ['2026-11-13T24:59:60+01:00', '2026-11-13T23:99:60+00:40', '2016-12-31T23:59:60Z', '2026-11-13 01:02:03Z',
    '2026-11-13T01:02:03+0100'])
    assert.equal(dateTime(instant), true, `ajv-formats now refuses ${instant}; the pattern may be simplified`);
});

test('section order, uniqueness, accelerators and part sections are refused by the schema and the verifier alike', async () => {
  const cases = {
    'sections out of order': m => { [m.sections[0], m.sections[1]] = [m.sections[1], m.sections[0]]; },
    'a repeated section': m => { m.sections[2] = { ...m.sections[0] }; },
    // Eleven sections still, so this reaches the missing-section rule rather than the count.
    'an evidence section missing, an accelerator in its place': m => {
      m.sections.pop(); m.sections.push({ name: 'embeddings', rows: 0, bytes: 0, accelerator: true }); },
    'embeddings not marked as an accelerator': m => { m.sections.push({ name: 'embeddings', rows: 0, bytes: 0, accelerator: false }); },
    'an evidence section marked as an accelerator': m => { m.sections[0].accelerator = true; },
    'a part of no export section': m => { m.parts[0].section = 'secrets'; }
  };
  for (const [label, change] of Object.entries(cases)) {
    const value = edit(change);
    assert.equal(valid(value), false, `the schema accepts ${label}`);
    const [text, digest] = sealed(value);
    assert.equal((await verifyExportManifest(text, digest)).ok, false, `the verifier accepts ${label}`);
  }
  // A detachment has no credential, every other event has one (migration 044).
  const events = ajv.getSchema(`${schema.$id}#/$defs/events`);
  const event = { eventId: 'eev_00000000-0000-4000-8000-000000000000', collectionId: 'alpha', kind: 'link', entityId: 'l', revision: 2, committedAt: '2026-11-13T01:02:03.123456Z' };
  assert.ok(events({ ...event, operation: 'detach', credentialId: null }), JSON.stringify(events.errors));
  assert.ok(events({ ...event, operation: 'delete', credentialId: 'cred_1' }), JSON.stringify(events.errors));
  assert.equal(events({ ...event, operation: 'detach', credentialId: 'cred_1' }), false, 'a detachment with a credential');
  assert.equal(events({ ...event, operation: 'delete', credentialId: null }), false, 'a deletion without a credential');
});

test('the rules the schema cannot state are refused too', async () => {
  const cases = {
    'a gap in part numbers': m => { m.parts[0].number = 2; },
    'a section that does not total its parts': m => { m.sections[1].rows = 2; }
  };
  for (const [label, change] of Object.entries(cases)) {
    const [text, digest] = sealed(edit(change));
    assert.equal((await verifyExportManifest(text, digest)).ok, false, `the verifier accepts ${label}`);
  }
});

test('with its data parts, every part holds the rows the manifest lists, ends its section on a whole line, and spans run forward', async () => {
  /** A manifest of `section` in `contents`, listing `rows` for each part, re-sealed, verified with those parts. */
  const check = async (contents, rows, section = 'schemas') => {
    const value = manifest();
    value.parts = contents.map((part, i) => ({ number: i + 1, section, rows: rows[i], bytes: Buffer.byteLength(part), sha256: sha(part) }));
    for (const entry of value.sections) {
      const own = value.parts.filter(part => part.section === entry.name);
      Object.assign(entry, { rows: own.reduce((n, part) => n + part.rows, 0), bytes: own.reduce((n, part) => n + part.bytes, 0) });
    }
    const [text, digest] = sealed(value);
    return verifyExportManifest(text, digest, contents);
  };
  // A line may continue into the next part: it counts in the part it ends in.
  assert.equal((await check(['{"collectionId":', '"alpha"}\n{"collectionId":"beta"}\n'], [0, 2])).ok, true);
  assert.equal((await check(['{"a":1}\n{"a":2}\n'], [1])).ok, false, 'two rows listed as one');
  assert.equal((await check(['{"a":1}\n', '{"a":2}'], [1, 0])).ok, false, 'a section ending in an unfinished line');
  const cite = (start, end) => `${JSON.stringify({ collectionId: 'alpha', claimId: 'c', revision: 1, ordinal: 0,
    source: { collectionId: 'alpha', sourceId: 's', extractionVersion: start === null ? null : 1, startOffset: start, endOffset: end } })}\n`;
  assert.equal((await check([cite(2, 5) + cite(3, 3) + cite(null, null)], [3], 'provenance')).ok, true);
  // The schema cannot compare two members, so a reversed span is the verifier's alone.
  const provenance = ajv.getSchema(`${schema.$id}#/$defs/provenance`);
  assert.ok(provenance(JSON.parse(cite(5, 2))), 'the schema states no span order');
  assert.equal((await check([cite(5, 2)], [1], 'provenance')).ok, false, 'a span that starts after its end');
  // Read part by part: a reversed span split across two parts is found, a forward one so split verifies.
  const split = (line, at) => [line.slice(0, at), line.slice(at)];
  assert.equal((await check(split(cite(2, 5), 40), [0, 1], 'provenance')).ok, true);
  assert.equal((await check(split(cite(5, 2), 40), [0, 1], 'provenance')).ok, false, 'a reversed span split across parts');
});

test('parts must be an array: null, a string or an array-like object is refused, never thrown on or trusted', async () => {
  const [text, digest] = sealed(manifest());
  for (const parts of [null, content, { length: 1, 0: content }, 42])
    assert.equal((await verifyExportManifest(text, digest, parts)).ok, false, `parts ${JSON.stringify(parts)} verified`);
  assert.equal((await verifyExportManifest(text, digest, [content])).ok, true);
});

test('integers verify up to 2^53 - 1, where a JSON number is still exact; a larger one is refused rather than rounded', async () => {
  const at = watermark => sealed(edit(m => { m.boundary.watermark = watermark; }));
  assert.equal((await verifyExportManifest(...at(Number.MAX_SAFE_INTEGER))).ok, true);
  // JSON.stringify writes 2^53 exactly; parsed back it is no longer a safe integer.
  assert.equal((await verifyExportManifest(...at(2 ** 53))).ok, false);
  const [text] = at(0);
  const big = text.replace('"watermark":0', '"watermark":9007199254740993');
  assert.equal((await verifyExportManifest(big, sha(big))).ok, false, 'a watermark that parses rounded');
});

test('a provenance row continued across thousands of parts verifies in linear time, and an over-long row is refused', async () => {
  /** Provenance `contents`, each part listing the rows it ends, re-sealed and verified with those parts. */
  const check = async contents => {
    const value = manifest();
    value.parts = contents.map((part, i) => ({ number: i + 1, section: 'provenance', rows: (part.match(/\n/g) ?? []).length,
      bytes: Buffer.byteLength(part), sha256: sha(part) }));
    for (const entry of value.sections) {
      const own = value.parts.filter(part => part.section === entry.name);
      Object.assign(entry, { rows: own.reduce((n, part) => n + part.rows, 0), bytes: own.reduce((n, part) => n + part.bytes, 0) });
    }
    const [text, digest] = sealed(value);
    return verifyExportManifest(text, digest, contents);
  };
  const row = (start, end, length) => {
    const base = { collectionId: 'alpha', claimId: '', revision: 1, ordinal: 0,
      source: { collectionId: 'alpha', sourceId: 's', extractionVersion: 1, startOffset: start, endOffset: end } };
    base.claimId = 'c'.repeat(length - JSON.stringify(base).length - 1);
    return `${JSON.stringify(base)}\n`;
  };
  const chunks = (line, count) => Array.from({ length: count }, (_, i) =>
    line.slice(Math.floor(i * line.length / count), Math.floor((i + 1) * line.length / count)));
  // One row of a million characters in 4,000 parts: carried once, never copied again for every part.
  const started = performance.now();
  assert.equal((await check(chunks(row(2, 5, 1_000_000), 4_000))).ok, true);
  assert.ok(performance.now() - started < 10_000, `took ${Math.round(performance.now() - started)} ms`);
  const reversed = await check(chunks(row(5, 2, 1_000_000), 4_000));
  assert.deepEqual(reversed, { ok: false, reason: 'a provenance span starts after its end' });
  // A row longer than a part's limit is refused, whether it ends or is still unfinished when the limit passes.
  const long = await check(chunks(row(2, 5, 1_048_578), 3));
  assert.equal(long.ok, false);
  assert.match(long.reason, /provenance row is longer than 1048576 characters/);
  // Refused while still unfinished: two parts carry more than the limit before the third would end the row.
  const carried = await check(chunks(row(2, 5, 2_200_000), 3));
  assert.deepEqual(carried, { ok: false, reason: 'a provenance row is longer than 1048576 characters' });
});
