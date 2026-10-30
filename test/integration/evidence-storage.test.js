import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresAuthority, PostgresSpaces } from '../../packages/postgres/dist/index.js';

// STA-32 storage only: no service writes these tables yet, so fixtures use SQL.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const names = ['evidence', 'evidence_upgrade'].map(kind => `stateplane_${kind}_${randomUUID().replaceAll('-', '')}`);
const urlFor = name => { const url = new URL(baseUrl); url.pathname = `/${name}`; return url.toString(); };
async function admin(sql) {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}
const dropDatabases = () => Promise.all(names.map(name => admin(`DROP DATABASE IF EXISTS ${name}`)));
const migrate = (name, env = {}) => spawnSync(process.execPath, ['scripts/migrate.mjs'],
  { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(name), ...env }, encoding: 'utf8' });
try {
  for (const name of names) await admin(`CREATE DATABASE ${name}`);
  execFileSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(names[0]) }, stdio: 'ignore' });
} catch (error) { await dropDatabases(); throw error; }
const pool = new pg.Pool({ connectionString: urlFor(names[0]), max: 6 });
test.after(async () => { await pool.end(); await dropDatabases(); });

const digest = value => createHash('sha256').update(value).digest('hex');
const code = (expected, constraint) => error => {
  assert.equal(error.code, expected, error.message);
  if (constraint) assert.equal(error.constraint, constraint);
  return true;
};
const immutable = /evidence facts are immutable/;

async function inTransaction(fn, client) {
  const owned = !client;
  client ??= await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { if (owned) client.release(); }
}

/** A space with two collections, one record in each. */
async function space() {
  const spaceId = `sp_${randomUUID()}`;
  const ids = ['alpha', 'beta'];
  await inTransaction(async db => {
    await db.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES($1,'owner','cell-a','cell-a','target-a')`, [spaceId]);
    for (const collectionId of ids) {
      await db.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)', [spaceId, collectionId]);
      await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,$2,1,'{}')`,
        [spaceId, collectionId]);
      await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
        VALUES($1,$2,$3,1,1,'generated',$3,'{}','{}'::jsonb)`, [spaceId, collectionId, `rec_${collectionId}`]);
    }
  });
  return { spaceId, alpha: 'alpha', beta: 'beta' };
}

/** Insert one endpoint's rows inside the caller's open transaction. */
async function insertEndpoint(db, spaceId, { kind, collectionId, id }, { referenceOnly = false, bytes = 'original bytes' } = {}) {
  if (kind === 'record') {
    await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
      VALUES($1,$2,$3,1,1,'generated',$3,'{}','{}'::jsonb)`, [spaceId, collectionId, id]);
    return;
  }
  await db.query('INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES($1,$2,$3,$4)', [spaceId, collectionId, kind, id]);
  if (kind === 'source') {
    await db.query(`INSERT INTO sources(space_id,collection_id,source_id,locator,principal_id,credential_id)
      VALUES($1,$2,$3,'https://example.invalid/evidence','owner','owner-session')`, [spaceId, collectionId, id]);
    await db.query(`INSERT INTO original_objects(space_id,collection_id,source_id,reference_only,sha256,byte_size,mime_type,captured_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()-interval '1 minute')`,
    [spaceId, collectionId, id, referenceOnly, referenceOnly ? null : digest(bytes),
      referenceOnly ? null : Buffer.byteLength(bytes), referenceOnly ? null : 'text/plain']);
  } else {
    await db.query(`INSERT INTO claims(space_id,collection_id,claim_id,principal_id,credential_id) VALUES($1,$2,$3,'owner','owner-session')`,
      [spaceId, collectionId, id]);
    await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id)
      VALUES($1,$2,$3,1,$4,'principal:owner','owner-session')`, [spaceId, collectionId, id, bytes]);
  }
}

async function source(spaceId, collectionId, options) {
  const sourceId = `src_${randomUUID()}`;
  await inTransaction(db => insertEndpoint(db, spaceId, { kind: 'source', collectionId, id: sourceId }, options));
  return sourceId;
}

async function extraction(spaceId, collectionId, sourceId, version, content, sha256 = digest('original bytes')) {
  await pool.query(`INSERT INTO extraction_versions(space_id,collection_id,source_id,version,source_sha256,parser,parser_version,content,source_offsets,credential_id)
    VALUES($1,$2,$3,$4,$5,'text','1',$6,$7::jsonb,'owner-session')`,
  [spaceId, collectionId, sourceId, version, sha256, content, JSON.stringify([{ content: [0, content.length], source: [0, content.length] }])]);
}

async function claim(spaceId, collectionId, statement = 'a generic assertion') {
  const claimId = `clm_${randomUUID()}`;
  await inTransaction(db => insertEndpoint(db, spaceId, { kind: 'claim', collectionId, id: claimId }, { bytes: statement }));
  return claimId;
}

async function link(spaceId, from, to, policy, { owner = from.collectionId, db = pool } = {}) {
  const linkId = `lnk_${randomUUID()}`;
  await db.query(`INSERT INTO links(space_id,collection_id,link_id,link_type,deletion_policy,
      from_kind,from_collection_id,from_id,to_kind,to_collection_id,to_id,credential_id)
    VALUES($1,$2,$3,'cites',$4,$5,$6,$7,$8,$9,$10,'owner-session')`,
  [spaceId, owner, linkId, policy, from.kind, from.collectionId, from.id, to.kind, to.collectionId, to.id]);
  return linkId;
}

/** The update a writer issues to logically delete one endpoint. */
function tombstone(db, spaceId, endpoint) {
  return endpoint.kind === 'record'
    ? db.query(`UPDATE records SET tombstone=true,revision=revision+1 WHERE space_id=$1 AND collection_id=$2 AND record_id=$3`,
      [spaceId, endpoint.collectionId, endpoint.id])
    : db.query(`UPDATE entity_refs SET tombstone=true,revision=revision+1 WHERE space_id=$1 AND collection_id=$2 AND kind=$3 AND entity_id=$4`,
      [spaceId, endpoint.collectionId, endpoint.kind, endpoint.id]);
}
async function live(spaceId, endpoint) {
  const result = endpoint.kind === 'record'
    ? await pool.query('SELECT NOT tombstone AS live FROM records WHERE space_id=$1 AND collection_id=$2 AND record_id=$3',
      [spaceId, endpoint.collectionId, endpoint.id])
    : await pool.query('SELECT NOT tombstone AS live FROM entity_refs WHERE space_id=$1 AND collection_id=$2 AND kind=$3 AND entity_id=$4',
      [spaceId, endpoint.collectionId, endpoint.kind, endpoint.id]);
  return result.rows[0].live;
}
const detach = (db, spaceId, owner, linkId) => db.query(`UPDATE links SET tombstone=true,revision=revision+1,tombstoned_at=clock_timestamp()
  WHERE space_id=$1 AND collection_id=$2 AND link_id=$3`, [spaceId, owner, linkId]);

test('original objects cannot change once committed, and a corrected extraction is a new version', async () => {
  const { spaceId, alpha } = await space();
  const sourceId = await source(spaceId, alpha);
  const where = [spaceId, alpha, sourceId];
  const before = (await pool.query('SELECT to_jsonb(o) AS row FROM original_objects o WHERE space_id=$1 AND collection_id=$2 AND source_id=$3', where)).rows[0].row;
  for (const change of [`mime_type='application/pdf'`, `sha256='${digest('other')}'`, 'byte_size=byte_size+1',
    `captured_at=captured_at-interval '1 day'`, 'reference_only=reference_only'])
    await assert.rejects(pool.query(`UPDATE original_objects SET ${change} WHERE space_id=$1 AND collection_id=$2 AND source_id=$3`, where), immutable);
  await assert.rejects(pool.query('DELETE FROM original_objects WHERE space_id=$1 AND collection_id=$2 AND source_id=$3', where), immutable);
  await assert.rejects(pool.query('TRUNCATE original_objects CASCADE'), immutable);
  assert.deepEqual((await pool.query('SELECT to_jsonb(o) AS row FROM original_objects o WHERE space_id=$1 AND collection_id=$2 AND source_id=$3', where)).rows[0].row, before);
  // Source provenance is fixed too; lifecycle lives in entity_refs.
  for (const change of [`locator='https://example.invalid/other'`, `principal_id='other'`, `credential_id='other'`, `created_at=created_at-interval '1 day'`])
    await assert.rejects(pool.query(`UPDATE sources SET ${change} WHERE space_id=$1 AND collection_id=$2 AND source_id=$3`, where), immutable);
  await assert.rejects(pool.query('DELETE FROM sources WHERE space_id=$1 AND collection_id=$2 AND source_id=$3', where), immutable);
  await assert.rejects(pool.query('TRUNCATE sources CASCADE'), immutable);

  await extraction(spaceId, alpha, sourceId, 1, 'first parse');
  await assert.rejects(pool.query(`UPDATE extraction_versions SET content='corrected' WHERE space_id=$1 AND collection_id=$2 AND source_id=$3`, where), immutable);
  await assert.rejects(pool.query('DELETE FROM extraction_versions WHERE space_id=$1 AND collection_id=$2 AND source_id=$3', where), immutable);
  await assert.rejects(pool.query('TRUNCATE extraction_versions CASCADE'), immutable);
  await extraction(spaceId, alpha, sourceId, 2, 'corrected parse');
  assert.deepEqual((await pool.query(`SELECT version::int,content FROM extraction_versions
    WHERE space_id=$1 AND collection_id=$2 AND source_id=$3 ORDER BY version`, where)).rows,
  [{ version: 1, content: 'first parse' }, { version: 2, content: 'corrected parse' }]);
  // Versions are contiguous, and each cites the digest of the bytes it parsed.
  await assert.rejects(extraction(spaceId, alpha, sourceId, 4, 'skipped a version'), code('23503'));
  await assert.rejects(extraction(spaceId, alpha, sourceId, 3, 'other bytes', digest('other bytes')), code('23503'));
  // A reference-only source has no fetched bytes to extract.
  const referenceOnly = await source(spaceId, alpha, { referenceOnly: true });
  await assert.rejects(extraction(spaceId, alpha, referenceOnly, 1, 'invented', digest('original bytes')), code('23503'));
});

test('originals record verified bytes or an explicit reference-only marker', async () => {
  const { spaceId, alpha } = await space();
  const insert = (values, db) => db.query(`INSERT INTO original_objects(space_id,collection_id,source_id,reference_only,sha256,byte_size,mime_type,captured_at,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, values);
  const now = new Date();
  const rows = [
    [true, digest('x'), 1, 'text/plain', now, now],        // reference-only cannot claim bytes
    [false, null, null, 'text/plain', now, now],           // stored original needs a digest
    [false, digest('x'), null, 'text/plain', now, now],    // and a size
    [false, digest('x'), 1, null, now, now],               // and a MIME type
    [false, digest('x'), -1, 'text/plain', now, now],
    [false, 'ABC', 1, 'text/plain', now, now],
    [false, digest('x'), 1, 'Text/Plain', now, now],
    [false, digest('x'), 1, 'text/plain; charset=utf-8', now, now],
    [false, digest('x'), 1, 'text/plain', new Date(now.getTime() + 1000), now] // captured after observed
  ];
  for (const values of rows) {
    const sourceId = `src_${randomUUID()}`;
    await assert.rejects(inTransaction(async db => {
      await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES($1,$2,'source',$3)`, [spaceId, alpha, sourceId]);
      await db.query(`INSERT INTO sources(space_id,collection_id,source_id,principal_id,credential_id) VALUES($1,$2,$3,'owner','s')`, [spaceId, alpha, sourceId]);
      await insert([spaceId, alpha, sourceId, ...values], db);
    }), code('23514'), JSON.stringify(values));
  }
  const referenceOnly = await source(spaceId, alpha, { referenceOnly: true });
  assert.deepEqual((await pool.query('SELECT reference_only,sha256,byte_size FROM original_objects WHERE source_id=$1', [referenceOnly])).rows,
    [{ reference_only: true, sha256: null, byte_size: null }]);
});

test('claim revisions and their evidence are immutable history with explicit review', async () => {
  const { spaceId, alpha, beta } = await space();
  const sourceId = await source(spaceId, beta);
  await extraction(spaceId, beta, sourceId, 1, 'cited text');
  const claimId = await claim(spaceId, alpha);
  const where = [spaceId, alpha, claimId];
  await pool.query(`INSERT INTO claim_evidence(space_id,collection_id,claim_id,revision,ordinal,source_collection_id,source_id,extraction_version,start_offset,end_offset)
    VALUES($1,$2,$3,1,0,$4,$5,1,0,5)`, [...where, beta, sourceId]);
  assert.equal((await pool.query('SELECT review_status FROM claim_revisions WHERE claim_id=$1', [claimId])).rows[0].review_status, 'unreviewed');
  await assert.rejects(pool.query(`UPDATE claim_revisions SET review_status='accepted',reviewed_by='reviewer',reviewed_at=clock_timestamp()
    WHERE space_id=$1 AND collection_id=$2 AND claim_id=$3`, where), immutable);
  await assert.rejects(pool.query('UPDATE claim_evidence SET end_offset=6 WHERE claim_id=$1', [claimId]), immutable);
  await assert.rejects(pool.query('DELETE FROM claim_revisions WHERE claim_id=$1', [claimId]), immutable);
  for (const change of [`principal_id='other'`, `credential_id='other'`, `created_at=created_at-interval '1 day'`])
    await assert.rejects(pool.query(`UPDATE claims SET ${change} WHERE space_id=$1 AND collection_id=$2 AND claim_id=$3`, where), immutable);
  await assert.rejects(pool.query('DELETE FROM claims WHERE space_id=$1 AND collection_id=$2 AND claim_id=$3', where), immutable);
  // Review is a new revision that names its reviewer; the current pointer moves with it.
  await inTransaction(async db => {
    await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,review_status,reviewed_by,reviewed_at)
      VALUES($1,$2,$3,2,'a generic assertion','principal:owner','reviewer','accepted','reviewer',clock_timestamp())`, where);
    await db.query(`UPDATE entity_refs SET revision=2 WHERE space_id=$1 AND collection_id=$2 AND kind='claim' AND entity_id=$3`, where);
  });
  await assert.rejects(pool.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,review_status)
    VALUES($1,$2,$3,3,'unattributed review','principal:owner','s','accepted')`, where), code('23514'));
  await assert.rejects(pool.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id)
    VALUES($1,$2,$3,5,'gap','principal:owner','s')`, where), code('23503'));
  // The current pointer cannot name a revision that does not exist.
  await assert.rejects(pool.query(`UPDATE entity_refs SET revision=3 WHERE space_id=$1 AND collection_id=$2 AND kind='claim' AND entity_id=$3`, where),
    code('23503', 'entity_refs_payload'));
  // Offsets need an extraction version and an ordered range.
  for (const [version, start, end] of [[null, 0, 1], [1, 4, 2], [1, -1, 2], [1, 0, null]])
    await assert.rejects(pool.query(`INSERT INTO claim_evidence(space_id,collection_id,claim_id,revision,ordinal,source_collection_id,source_id,extraction_version,start_offset,end_offset)
      VALUES($1,$2,$3,2,0,$4,$5,$6,$7,$8)`, [...where, beta, sourceId, version, start, end]), code('23514'));
});

test('every source, claim, grant and link row is scoped to its space and an owning collection', async () => {
  const tables = ['sources', 'original_objects', 'source_upload_grants', 'source_upload_attempts', 'extraction_versions',
    'claims', 'claim_revisions', 'claim_evidence', 'links'];
  // Each table has a foreign key that starts with (space_id, collection_id), and
  // following those keys always reaches `collections`.
  const keys = (await pool.query(`SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
      (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS columns
    FROM pg_constraint c WHERE c.contype='f' AND c.connamespace='public'::regnamespace`)).rows
    .filter(key => key.columns[0] === 'space_id' && key.columns[1] === 'collection_id');
  const reaches = (table, seen = new Set()) => table === 'collections' || (!seen.has(table) && seen.add(table) &&
    keys.some(key => key.child === table && key.parent !== table && reaches(key.parent, seen)));
  for (const table of tables) assert.ok(reaches(table), `${table} reaches collections by an owning-collection key`);

  const { spaceId, alpha, beta } = await space();
  const other = await space();
  // Payload rows need their space-scoped identity, and identities their payload at commit.
  await assert.rejects(pool.query(`INSERT INTO sources(space_id,collection_id,source_id,principal_id,credential_id)
    VALUES($1,'missing','src_x','owner','s')`, [spaceId]), code('23503'));
  await assert.rejects(pool.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES($1,$2,'source','src_bare')`,
    [spaceId, alpha]), code('23503', 'entity_refs_payload'));
  await assert.rejects(inTransaction(async db => {
    await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES($1,$2,'source','src_no_original')`, [spaceId, alpha]);
    await db.query(`INSERT INTO sources(space_id,collection_id,source_id,principal_id,credential_id) VALUES($1,$2,'src_no_original','owner','s')`, [spaceId, alpha]);
  }), code('23503', 'sources_original'));
  await assert.rejects(pool.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES($1,$2,'claim','clm_bare')`,
    [spaceId, alpha]), code('23503', 'entity_refs_payload'));
  // A claim's identity kind must match: a source identity cannot hold claim rows.
  const sourceId = await source(spaceId, alpha);
  await assert.rejects(pool.query(`INSERT INTO claims(space_id,collection_id,claim_id,principal_id,credential_id) VALUES($1,$2,$3,'owner','s')`,
    [spaceId, alpha, sourceId]), code('23503'));
  // Evidence may cite another collection in the same space, never another space.
  const claimId = await claim(spaceId, alpha);
  const foreignSource = await source(other.spaceId, alpha);
  await assert.rejects(pool.query(`INSERT INTO claim_evidence(space_id,collection_id,claim_id,revision,ordinal,source_collection_id,source_id)
    VALUES($1,$2,$3,1,0,$2,$4)`, [spaceId, alpha, claimId, foreignSource]), code('23503'));
  await assert.rejects(pool.query(`INSERT INTO source_upload_grants(space_id,collection_id,grant_id,principal_id,credential_id,mime_type,max_bytes,expires_at)
    VALUES($1,'missing','grant','owner','s','text/plain',10,clock_timestamp()+interval '5 minutes')`, [spaceId]), code('23503'));

  const record = { kind: 'record', collectionId: alpha, id: 'rec_alpha' };
  // Endpoints and owner share the link's space; the owner is one endpoint's collection.
  await assert.rejects(link(spaceId, record, { kind: 'record', collectionId: alpha, id: 'rec_alpha_elsewhere' }, 'restrict'), code('23503'));
  await assert.rejects(link(spaceId, record, { kind: 'source', collectionId: alpha, id: foreignSource }, 'restrict'), code('23503'));
  await assert.rejects(link(spaceId, record, { kind: 'claim', collectionId: alpha, id: sourceId }, 'restrict'), code('23503'));
  await inTransaction(async db => {
    await db.query(`INSERT INTO collections(space_id,collection_id) VALUES($1,'gamma')`, [spaceId]);
    await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,'gamma',1,'{}')`, [spaceId]);
  });
  // A third collection cannot own a link between two others.
  await assert.rejects(link(spaceId, record, { kind: 'record', collectionId: beta, id: 'rec_beta' }, 'restrict', { owner: 'gamma' }), code('23514'));
  await assert.rejects(link(spaceId, record, record, 'detach'), code('23514'));
  for (const [field, value] of [['deletion_policy', 'cascade'], ['from_kind', 'collection']])
    await assert.rejects(pool.query(`INSERT INTO links(space_id,collection_id,link_id,link_type,deletion_policy,from_kind,from_collection_id,from_id,to_kind,to_collection_id,to_id,credential_id)
      VALUES($1,$2,'lnk_bad','cites',$3,$4,$2,'rec_alpha','record',$5,'rec_beta','s')`,
    [spaceId, alpha, field === 'deletion_policy' ? value : 'restrict', field === 'from_kind' ? value : 'record', beta]), code('23514'));
  const linkId = await link(spaceId, record, { kind: 'source', collectionId: alpha, id: sourceId }, 'restrict', { owner: alpha });
  assert.ok(linkId);
});

test('links change only by tombstoning forward and are never deleted outside erasure', async () => {
  const { spaceId, alpha, beta } = await space();
  const from = { kind: 'record', collectionId: alpha, id: 'rec_alpha' };
  const linkId = await link(spaceId, from, { kind: 'record', collectionId: beta, id: 'rec_beta' }, 'detach');
  const where = [spaceId, alpha, linkId];
  for (const change of [`link_type='other'`, `deletion_policy='restrict'`, `to_id='rec_alpha'`, `collection_id='beta'`, 'revision=revision+1',
    `tombstone=true,revision=revision+2,tombstoned_at=clock_timestamp()`, `tombstone=true,revision=revision+1,tombstoned_at=clock_timestamp(),link_type='x'`])
    await assert.rejects(pool.query(`UPDATE links SET ${change} WHERE space_id=$1 AND collection_id=$2 AND link_id=$3`, where), /links change only by tombstoning|violates/);
  await assert.rejects(pool.query('DELETE FROM links WHERE space_id=$1 AND collection_id=$2 AND link_id=$3', where), immutable);
  await assert.rejects(pool.query('TRUNCATE links'), immutable);
  await detach(pool, spaceId, alpha, linkId);
  await assert.rejects(pool.query(`UPDATE links SET tombstone=false,revision=revision+1,tombstoned_at=NULL
    WHERE space_id=$1 AND collection_id=$2 AND link_id=$3`, where), /links change only by tombstoning/);
  await assert.rejects(pool.query(`INSERT INTO links(space_id,collection_id,link_id,link_type,deletion_policy,from_kind,from_collection_id,from_id,to_kind,to_collection_id,to_id,credential_id,tombstone,tombstoned_at,revision)
    VALUES($1,$2,'lnk_born_dead','cites','detach','record',$2,'rec_alpha','record',$3,'rec_beta','s',true,clock_timestamp(),2)`,
  [spaceId, alpha, beta]), /links are created live at revision 1/);
});

test('restrict and detach links govern deletion of every endpoint kind', async () => {
  for (const kind of ['record', 'source', 'claim']) {
    const { spaceId, alpha, beta } = await space();
    const endpoint = kind === 'record' ? { kind, collectionId: beta, id: 'rec_beta' }
      : { kind, collectionId: beta, id: kind === 'source' ? await source(spaceId, beta) : await claim(spaceId, beta) };
    const anchor = { kind: 'record', collectionId: alpha, id: 'rec_alpha' };
    // Each endpoint may appear on either side of a link.
    const restricting = await link(spaceId, endpoint, anchor, 'restrict');
    const detaching = await link(spaceId, anchor, endpoint, 'detach');
    await assert.rejects(inTransaction(db => tombstone(db, spaceId, endpoint)), code('23001', 'links_restrict'), kind);
    assert.equal(await live(spaceId, endpoint), true);
    // Mixed policies still reject the whole deletion, even after detaching first.
    await assert.rejects(inTransaction(async db => {
      await detach(db, spaceId, alpha, detaching);
      await tombstone(db, spaceId, endpoint);
    }), code('23001', 'links_restrict'), kind);
    assert.equal((await pool.query('SELECT tombstone FROM links WHERE link_id=$1', [detaching])).rows[0].tombstone, false);
    await detach(pool, spaceId, beta, restricting);
    // A live detach link must be tombstoned with its endpoint, never left dangling.
    await assert.rejects(inTransaction(db => tombstone(db, spaceId, endpoint)), code('23503', 'links_detach'), kind);
    await inTransaction(async db => {
      await detach(db, spaceId, alpha, detaching);
      await tombstone(db, spaceId, endpoint);
    });
    assert.equal(await live(spaceId, endpoint), false);
    await assert.rejects(link(spaceId, anchor, endpoint, 'detach'), code('23503', 'links_live_endpoint'), kind);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM links l WHERE l.space_id=$1 AND NOT l.tombstone`, [spaceId])).rows[0].n, 0);
  }
});

/** Wait until `pid` is blocked on a lock held by another session. */
async function blocked(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting', [pid])).rows[0].waiting) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('session never waited for the competing lock');
}

const isolations = { rc: 'READ COMMITTED', rr: 'REPEATABLE READ', ser: 'SERIALIZABLE' };
const danglingLinks = async spaceId => (await pool.query(`SELECT count(*)::int AS n FROM links l
  LEFT JOIN records r ON l.to_kind='record' AND r.space_id=l.space_id AND r.collection_id=l.to_collection_id AND r.record_id=l.to_id
  LEFT JOIN entity_refs e ON l.to_kind<>'record' AND e.space_id=l.space_id AND e.collection_id=l.to_collection_id
    AND e.kind=l.to_kind AND e.entity_id=l.to_id
  WHERE l.space_id=$1 AND NOT l.tombstone AND coalesce(r.tombstone,e.tombstone)`, [spaceId])).rows[0].n;

test('a link racing its endpoint deletion cannot leave a live dangling link at any isolation level', async () => {
  // [deleter, linker] isolation pairs, including snapshot-isolated writers
  // racing READ COMMITTED ones in both roles.
  const pairs = [['rc', 'rc'], ['ser', 'rc'], ['rr', 'rc'], ['rc', 'rr'], ['rc', 'ser'], ['ser', 'ser']];
  for (const kind of ['record', 'source', 'claim']) {
    for (const [deleterLevel, linkerLevel] of pairs) {
      for (const first of ['link', 'delete']) {
        const label = `${kind} ${first} first, deleter ${deleterLevel}, linker ${linkerLevel}`;
        const { spaceId, alpha, beta } = await space();
        const endpoint = kind === 'record' ? { kind, collectionId: beta, id: 'rec_beta' }
          : { kind, collectionId: beta, id: kind === 'source' ? await source(spaceId, beta) : await claim(spaceId, beta) };
        const anchor = { kind: 'record', collectionId: alpha, id: 'rec_alpha' };
        const linker = await pool.connect();
        const deleter = await pool.connect();
        try {
          // Each first statement fixes a snapshot-isolated transaction's snapshot
          // before the other side commits.
          await linker.query(`BEGIN ISOLATION LEVEL ${isolations[linkerLevel]}`);
          await deleter.query(`BEGIN ISOLATION LEVEL ${isolations[deleterLevel]}`);
          const deleterPid = (await deleter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const linkerPid = (await linker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          if (first === 'link') {
            await link(spaceId, anchor, endpoint, 'detach', { db: linker });
            const deletion = tombstone(deleter, spaceId, endpoint).then(() => deleter.query('COMMIT')).then(() => 'deleted', error => error);
            await blocked(deleterPid);
            await linker.query('COMMIT');
            const outcome = await deletion;
            assert.ok(outcome instanceof Error, `${label}: deletion must fail`);
            if (deleterLevel === 'rc') code('23503', 'links_detach')(outcome); else code('40001')(outcome);
            assert.equal(await live(spaceId, endpoint), true, label);
          } else {
            await tombstone(deleter, spaceId, endpoint);
            const creation = link(spaceId, anchor, endpoint, 'detach', { db: linker }).then(() => linker.query('COMMIT'))
              .then(() => 'linked', error => error);
            await blocked(linkerPid);
            await deleter.query('COMMIT');
            const outcome = await creation;
            assert.ok(outcome instanceof Error, `${label}: link creation must fail`);
            if (linkerLevel === 'rc') code('23503', 'links_live_endpoint')(outcome); else code('40001')(outcome);
            assert.equal(await live(spaceId, endpoint), false, label);
          }
        } finally {
          await linker.query('ROLLBACK').catch(() => {});
          await deleter.query('ROLLBACK').catch(() => {});
          linker.release(); deleter.release();
        }
        assert.equal(await danglingLinks(spaceId), 0, label);
      }
    }
  }
});

/** Resolve once `promise` settles or session `pid` waits on another session's lock. */
async function settledOrBlocked(promise, pid) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let attempt = 0; attempt < 100 && !settled; attempt++) {
    if ((await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting', [pid])).rows[0].waiting) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!settled) throw new Error('session neither finished nor waited for the competing lock');
}

test('a link endpoint created by a concurrent transaction while the link waits is never accepted unfenced', async () => {
  // Endpoints are rewritten in (kind, collection, id) order. A held source in
  // beta sorts after any endpoint in alpha, and a held claim in alpha sorts
  // before any endpoint in beta, so the new endpoint is reached first or second.
  for (const kind of ['record', 'source', 'claim']) {
    for (const [order, created] of [['first', 'tombstoned'], ['first', 'live'], ['second', 'tombstoned'], ['second', 'live']]) {
      for (const linkerLevel of ['rc', 'ser']) {
        const label = `${kind} reached ${order}, created ${created}, linker ${linkerLevel}`;
        const { spaceId, alpha, beta } = await space();
        const held = order === 'first' ? { kind: 'source', collectionId: beta, id: await source(spaceId, beta) }
          : { kind: 'claim', collectionId: alpha, id: await claim(spaceId, alpha) };
        const fresh = { kind, collectionId: order === 'first' ? alpha : beta, id: `new_${randomUUID()}` };
        const writer = await pool.connect();
        const linker = await pool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query(`SELECT 1 FROM entity_refs WHERE space_id=$1 AND collection_id=$2 AND kind=$3 AND entity_id=$4 FOR UPDATE`,
            [spaceId, held.collectionId, held.kind, held.id]);
          await linker.query(`BEGIN ISOLATION LEVEL ${isolations[linkerLevel]}`);
          const linkerPid = (await linker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const creation = link(spaceId, fresh, held, 'restrict', { owner: held.collectionId, db: linker })
            .then(() => linker.query('COMMIT')).then(() => 'linked', error => error);
          await settledOrBlocked(creation, linkerPid);
          await insertEndpoint(writer, spaceId, fresh);
          if (created === 'tombstoned') await tombstone(writer, spaceId, fresh);
          await writer.query('COMMIT');
          const outcome = await creation;
          if (order === 'second' && created === 'live' && linkerLevel === 'rc') assert.equal(outcome, 'linked', label);
          else {
            // Absent from the linker's view when reached, or committed tombstoned.
            assert.ok(outcome instanceof Error, `${label}: link creation must fail`);
            code('23503', 'links_live_endpoint')(outcome);
          }
          assert.equal(await live(spaceId, fresh), created === 'live', label);
        } finally {
          await writer.query('ROLLBACK').catch(() => {});
          await linker.query('ROLLBACK').catch(() => {});
          writer.release(); linker.release();
        }
        const dangling = (await pool.query(`SELECT count(*)::int AS n FROM links l
          LEFT JOIN records r ON l.from_kind='record' AND r.space_id=l.space_id AND r.collection_id=l.from_collection_id AND r.record_id=l.from_id
          LEFT JOIN entity_refs e ON l.from_kind<>'record' AND e.space_id=l.space_id AND e.collection_id=l.from_collection_id
            AND e.kind=l.from_kind AND e.entity_id=l.from_id
          WHERE l.space_id=$1 AND NOT l.tombstone AND coalesce(r.tombstone,e.tombstone,true)`, [spaceId])).rows[0].n;
        assert.equal(dangling, 0, label);
      }
    }
  }
});

test('links created in opposite directions between the same endpoints queue instead of deadlocking', async () => {
  const { spaceId, alpha, beta } = await space();
  const first = { kind: 'record', collectionId: alpha, id: 'rec_alpha' };
  const second = { kind: 'record', collectionId: beta, id: 'rec_beta' };
  const [holder, forward, backward] = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
  try {
    // Hold the endpoint both links reach first, so both creations queue on it.
    // Rewriting in from/to order instead would let the reverse link take the
    // other endpoint meanwhile and deadlock once the holder commits.
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM records WHERE space_id=$1 AND collection_id=$2 AND record_id=$3 FOR UPDATE', [spaceId, alpha, first.id]);
    const creations = [];
    for (const [db, from, to] of [[forward, first, second], [backward, second, first]]) {
      await db.query('BEGIN');
      const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      creations.push(link(spaceId, from, to, 'detach', { db }).then(() => db.query('COMMIT')).then(() => 'linked', error => error));
      await blocked(pid);
    }
    await holder.query('COMMIT');
    assert.deepEqual(await Promise.all(creations), ['linked', 'linked']);
  } finally {
    for (const db of [holder, forward, backward]) { await db.query('ROLLBACK').catch(() => {}); db.release(); }
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM links WHERE space_id=$1 AND NOT tombstone', [spaceId])).rows[0].n, 2);
});

test('authority record deletes work under snapshot isolation defaults and still honor links', async () => {
  for (const level of ['repeatable read', 'serializable']) {
    const sessionPool = new pg.Pool({ connectionString: urlFor(names[0]), max: 2,
      options: `-c default_transaction_isolation=${level.replace(' ', '\\ ')}` });
    try {
      assert.equal((await sessionPool.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation, level);
      const { spaceId, alpha } = await space();
      const authority = new PostgresAuthority(sessionPool, 3600);
      const scope = { spaceId, collectionId: alpha, principalId: 'owner', credentialId: 'owner-session', capability: 'records:write',
        policyVersion: 1, placementGeneration: 1 };
      let n = 0;
      const mutate = change => authority.mutate(scope, { idempotencyKey: `k${n}`, requestDigest: digest(String(n++)), ...change });
      const create = async () => (await mutate({ operation: 'create', canonicalData: '{}', unique: [], indexes: [] })).ref.id;
      const remove = recordId => mutate({ operation: 'delete', recordId, expectedRevision: 1 });
      const unlinked = await create();
      await remove(unlinked);
      assert.equal(await live(spaceId, { kind: 'record', collectionId: alpha, id: unlinked }), false, level);
      const linked = await create();
      const restricting = await link(spaceId, { kind: 'record', collectionId: alpha, id: 'rec_alpha' },
        { kind: 'record', collectionId: alpha, id: linked }, 'restrict');
      await assert.rejects(remove(linked), code('23001', 'links_restrict'));
      assert.equal(await live(spaceId, { kind: 'record', collectionId: alpha, id: linked }), true, level);
      await detach(pool, spaceId, alpha, restricting);
      await remove(linked);
      assert.equal(await live(spaceId, { kind: 'record', collectionId: alpha, id: linked }), false, level);
    } finally { await sessionPool.end(); }
  }
});

test('upload grants and attempts keep finalize, revocation and staging cleanup unambiguous', async () => {
  const { spaceId, alpha } = await space();
  const issued = new Date();
  const grant = (grantId, maxBytes, lifetimeMs) => pool.query(`INSERT INTO source_upload_grants(space_id,collection_id,grant_id,principal_id,credential_id,mime_type,max_bytes,issued_at,expires_at)
    VALUES($1,$2,$3,'owner','owner-session','text/plain',$4,$5,$6)`, [spaceId, alpha, grantId, maxBytes, issued, new Date(issued.getTime() + lifetimeMs)]);
  await assert.rejects(grant('empty', 0, 300_000), code('23514'));
  await assert.rejects(grant('expired', 1, 0), code('23514'));
  await assert.rejects(grant('inverted', 1, -1), code('23514'));
  const grantId = `upl_${randomUUID()}`;
  await grant(grantId, 1024, 300_000);
  const sourceId = await source(spaceId, alpha);
  await assert.rejects(pool.query(`UPDATE source_upload_grants SET finalized_at=clock_timestamp() WHERE grant_id=$1`, [grantId]), code('23514'));
  await pool.query(`UPDATE source_upload_grants SET finalized_at=clock_timestamp(),source_id=$2 WHERE grant_id=$1`, [grantId, sourceId]);
  await assert.rejects(pool.query(`UPDATE source_upload_grants SET revoked_at=clock_timestamp() WHERE grant_id=$1`, [grantId]), code('23514'));
  const attempt = (attemptId, staging, state = 'receiving', observed = null, failure = null) => pool.query(`INSERT INTO source_upload_attempts(
      space_id,collection_id,grant_id,attempt_id,staging_key,state,observed_sha256,observed_bytes,failure_code)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [spaceId, alpha, grantId, attemptId, staging, state, observed, observed && 14, failure]);
  await attempt('a1', `staging/${grantId}/a1`, 'failed', null, 'DIGEST_MISMATCH');
  await assert.rejects(attempt('a2', `staging/${grantId}/a1`), code('23505'));
  await assert.rejects(attempt('a2', `staging/${grantId}/a2`, 'committed'), code('23514'));
  await assert.rejects(attempt('a2', `staging/${grantId}/a2`, 'failed'), code('23514'));
  await attempt('a2', `staging/${grantId}/a2`, 'committed', digest('original bytes'));
  await assert.rejects(attempt('a3', `staging/${grantId}/a3`, 'committed', digest('original bytes')), code('23505'));
  assert.deepEqual((await pool.query(`SELECT attempt_id FROM source_upload_attempts WHERE grant_id=$1 AND staging_removed_at IS NULL ORDER BY attempt_id`,
    [grantId])).rows.map(row => row.attempt_id), ['a1', 'a2']);
});

/** Seed one row in every evidence table for a space. */
async function evidence(spaceId, alpha, beta) {
  const sourceId = await source(spaceId, beta);
  await extraction(spaceId, beta, sourceId, 1, 'erasable text');
  const claimId = await claim(spaceId, alpha);
  await pool.query(`INSERT INTO claim_evidence(space_id,collection_id,claim_id,revision,ordinal,source_collection_id,source_id,extraction_version,start_offset,end_offset)
    VALUES($1,$2,$3,1,0,$4,$5,1,0,4)`, [spaceId, alpha, claimId, beta, sourceId]);
  await link(spaceId, { kind: 'claim', collectionId: alpha, id: claimId }, { kind: 'source', collectionId: beta, id: sourceId }, 'restrict');
  const grantId = `upl_${randomUUID()}`;
  await pool.query(`INSERT INTO source_upload_grants(space_id,collection_id,grant_id,principal_id,credential_id,mime_type,max_bytes,expires_at,finalized_at,source_id)
    VALUES($1,$2,$3,'owner','s','text/plain',64,clock_timestamp()+interval '5 minutes',clock_timestamp(),$4)`, [spaceId, beta, grantId, sourceId]);
  await pool.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key,state,observed_sha256,observed_bytes)
    VALUES($1,$2,$3,'a1',$4,'committed',$5,14)`, [spaceId, beta, grantId, `staging/${grantId}`, digest('original bytes')]);
}
const evidenceTables = ['sources', 'original_objects', 'source_upload_grants', 'source_upload_attempts', 'extraction_versions',
  'claims', 'claim_revisions', 'claim_evidence', 'links', 'entity_refs'];
const counts = async spaceId => Object.fromEntries(await Promise.all(evidenceTables.map(async table =>
  [table, (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`, [spaceId])).rows[0].n])));

test('space erasure removes every evidence row of that space only', async () => {
  const erased = await space();
  const kept = await space();
  await evidence(erased.spaceId, erased.alpha, erased.beta);
  await evidence(kept.spaceId, kept.alpha, kept.beta);
  const keptBefore = await counts(kept.spaceId);
  assert.ok(Object.values(keptBefore).every(n => n > 0));
  // The erasure setting alone does not let a non-owner remove facts.
  const role = `sta32_writer_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE ROLE ${role}`);
  const client = await pool.connect();
  try {
    await pool.query(`GRANT SELECT, DELETE ON original_objects, extraction_versions, claim_revisions, claim_evidence, links TO ${role}`);
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('stateplane.erasing_space',$1,true)", [erased.spaceId]);
    for (const table of ['links', 'claim_evidence', 'claim_revisions', 'extraction_versions', 'original_objects']) {
      await client.query('SAVEPOINT attempt');
      await assert.rejects(client.query(`DELETE FROM ${table} WHERE space_id=$1`, [erased.spaceId]), immutable, table);
      await client.query('ROLLBACK TO SAVEPOINT attempt');
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.query(`REVOKE ALL ON original_objects, extraction_versions, claim_revisions, claim_evidence, links FROM ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
  await assert.rejects(pool.query('SELECT stateplane_purge_space($1)', [erased.spaceId]), /space is not deleting/);
  await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [erased.spaceId]);
  await pool.query('SELECT stateplane_purge_space($1)', [erased.spaceId]);
  assert.deepEqual(await counts(erased.spaceId), Object.fromEntries(evidenceTables.map(table => [table, 0])));
  assert.deepEqual(await counts(kept.spaceId), keptBefore);
  assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1', [erased.spaceId])).rows[0].lifecycle, 'deleted');
});

test('a nonowner cell role proves evidence erasure only with the evidence grants', async () => {
  const actor = { kind: 'session', credentialId: 'session', userPrincipalId: 'erasure-owner' };
  const keys = { create: async () => { throw new Error('unexpected key'); }, find: async () => null, revoke: async () => {} };
  const identity = { current: async () => true };
  const spacesFor = cellPool => new PostgresSpaces(pool, new Map([['cell-a', { pool: cellPool, storageTargetId: 'target-a' }]]),
    'cell-a', keys, identity);
  const { spaceId } = await spacesFor(pool).create(actor);
  await inTransaction(async db => {
    for (const collectionId of ['alpha', 'beta']) {
      await db.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)', [spaceId, collectionId]);
      await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,$2,1,'{}')`,
        [spaceId, collectionId]);
    }
  });
  await evidence(spaceId, 'alpha', 'beta');
  await spacesFor(pool).archive(actor, spaceId);
  // Stand-in for the role's pre-040 provisioning: every other table, the
  // purge routine, and nothing on the evidence tables.
  const role = `sta32_cell_${randomUUID().replaceAll('-', '')}`;
  const evidenceGrants = evidenceTables.filter(table => table !== 'entity_refs');
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  const cellPool = new pg.Pool({ connectionString: urlFor(names[0]), max: 2, options: `-c role=${role}` });
  try {
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`REVOKE ALL ON ${evidenceGrants.join(',')} FROM ${role}`);
    await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await pool.query(`GRANT EXECUTE ON FUNCTION stateplane_purge_space(text) TO ${role}`);
    const spaces = spacesFor(cellPool);
    // Without the evidence grants the purge commits, but erasure cannot be proven or published.
    await assert.rejects(spaces.delete(actor, spaceId), code('42501'));
    assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1', [spaceId])).rows[0].lifecycle, 'deleted');
    assert.equal((await pool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1', [spaceId])).rows[0].lifecycle, 'deleting');
    await assert.rejects(spaces.reconcile(spaceId), code('42501'));

    execFileSync(process.execPath, ['scripts/grant-evidence.mjs'], { cwd: root, stdio: 'pipe',
      env: { ...process.env, STATEPLANE_CELL_ADMIN_URL: urlFor(names[0]), STATEPLANE_CELL_ROLE: role } });
    const privileges = (await pool.query(`SELECT t, has_table_privilege($1,t,'SELECT') AS can_read,
        has_table_privilege($1,t,'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write FROM unnest($2::text[]) t`, [role, evidenceGrants])).rows;
    assert.deepEqual(privileges.filter(row => !row.can_read || row.can_write), [], 'the grant is read-only');
    await spaces.delete(actor, spaceId);
    await spaces.delete(actor, spaceId);
    await spaces.reconcile(spaceId);
    await spaces.repairDeletedErasure(actor, spaceId);
    assert.equal((await pool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1', [spaceId])).rows[0].lifecycle, 'deleted');
    assert.deepEqual(await counts(spaceId), Object.fromEntries(evidenceTables.map(table => [table, 0])));
  } finally {
    await cellPool.end();
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
});

test('evidence grants refuse an invalid or missing role and an unverified external URL without leaking secrets', () => {
  const grant = env => spawnSync(process.execPath, ['scripts/grant-evidence.mjs'], { cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, ...env } });
  const external = new URL('postgres://db.example.invalid/stateplane');
  external.username = 'admin';
  external.password = ['private', 'fixture'].join('-');
  const cases = [
    [{ STATEPLANE_CELL_ADMIN_URL: urlFor(names[0]), STATEPLANE_CELL_ROLE: 'Bad"role' }, /valid STATEPLANE_CELL_ROLE/],
    [{ STATEPLANE_CELL_ADMIN_URL: urlFor(names[0]), STATEPLANE_CELL_ROLE: 'pg_read_all_data' }, /valid STATEPLANE_CELL_ROLE/],
    [{ STATEPLANE_CELL_ADMIN_URL: urlFor(names[0]), STATEPLANE_CELL_ROLE: `missing_${randomUUID().slice(0, 8)}` }, /Cell operational role does not exist/],
    [{ STATEPLANE_CELL_ADMIN_URL: external.href, STATEPLANE_CELL_ROLE: 'cell_reader' }, /External DATABASE_URL requires sslmode=verify-full/],
  ];
  for (const [env, expected] of cases) {
    const result = grant(env);
    assert.equal(result.status, 1, env.STATEPLANE_CELL_ROLE);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stdout + result.stderr, /private-fixture|Evidence erasure grants verified/);
    if (password) assert.ok(!(result.stdout + result.stderr).includes(password));
  }
});

test('migration 040 rolls back atomically while record writers hold locks, then applies to a populated database', { timeout: 60000 }, async () => {
  const name = names[1];
  const files = (await readdir(new URL('../../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
  assert.equal(files.at(-1), '040_evidence_storage.sql');
  const db = new pg.Client({ connectionString: urlFor(name) });
  const writer = new pg.Client({ connectionString: urlFor(name) });
  await db.connect();
  await writer.connect();
  try {
    await db.query('BEGIN');
    await db.query('CREATE TABLE stateplane_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files.slice(0, -1)) {
      const sql = await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
      await db.query(sql);
      await db.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)', [file, digest(sql)]);
    }
    await db.query('COMMIT');
    await db.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id) VALUES('sp_upgrade','owner','cell-a','cell-a','target-a')`);
    await db.query('BEGIN');
    await db.query(`INSERT INTO collections(space_id,collection_id) VALUES('sp_upgrade','entries')`);
    await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES('sp_upgrade','entries',1,'{}')`);
    await db.query('COMMIT');
    await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
      SELECT 'sp_upgrade','entries','rec_'||n,1,1,'generated','rec_'||n,'{}','{}'::jsonb FROM generate_series(1,200) n`);
    const recordsBefore = (await db.query('SELECT to_jsonb(r) AS row FROM records r ORDER BY record_id')).rows;
    const purgeBefore = (await db.query(`SELECT prosrc FROM pg_proc WHERE proname='stateplane_purge_space'`)).rows[0].prosrc;

    // An in-flight record writer holds the table lock 040 needs.
    await writer.query('BEGIN');
    await writer.query(`UPDATE records SET updated_at=clock_timestamp() WHERE record_id='rec_1'`);
    const refused = migrate(name);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Evidence storage upgrade waits for record writers/);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM stateplane_migrations WHERE name='040_evidence_storage.sql'`)).rows[0].n, 0);
    assert.deepEqual((await db.query(`SELECT to_regclass('public.links') AS links, to_regclass('public.original_objects') AS originals,
      to_regtype('public.stateplane_sha256') AS domain`)).rows[0], { links: null, originals: null, domain: null });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('records_link_endpoint','entity_refs_link_endpoint','entity_refs_payload')`)).rows[0].n, 0);
    assert.equal((await db.query(`SELECT prosrc FROM pg_proc WHERE proname='stateplane_purge_space'`)).rows[0].prosrc, purgeBefore);
    await writer.query('ROLLBACK');

    const applied = migrate(name);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Applied 040_evidence_storage.sql/);
    const sql = await readFile(new URL('../../migrations/040_evidence_storage.sql', import.meta.url), 'utf8');
    assert.equal((await db.query(`SELECT sha256 FROM stateplane_migrations WHERE name='040_evidence_storage.sql'`)).rows[0].sha256, digest(sql));
    assert.deepEqual((await db.query('SELECT to_jsonb(r) AS row FROM records r ORDER BY record_id')).rows, recordsBefore);
    // Upgraded and fresh schemas carry the same evidence constraints.
    const constraints = async client => (await client.query(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname`)).rows;
    const fresh = await pool.connect();
    try { assert.deepEqual(await constraints(db), await constraints(fresh)); } finally { fresh.release(); }
    // Existing records remain deletable once 040 is in place.
    await db.query(`UPDATE records SET tombstone=true,revision=2 WHERE record_id='rec_2'`);
    assert.equal(migrate(name).status, 0, 'a recorded 040 is skipped');
  } finally {
    await writer.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([db.end(), writer.end()]);
  }
});
