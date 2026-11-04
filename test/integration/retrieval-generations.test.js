import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresProjectionGenerations } from '../../packages/postgres/dist/index.js';
import { DeterministicEmbedder, EmbedderUnavailableError, EmbeddingRegistry } from '../../packages/retrieval/dist/index.js';
import { claims, fixture, healthy, ids, index, pool, rejects, search, spaces } from './retrieval-harness.js';

// STA-48: rebuilds, model migration, verified activation, rollback and
// retirement on PostgreSQL with pgvector, through the real record, source and
// claim services. Generation 1 of each collection is the harness's active one,
// built by the STA-45 worker with model version 1.

const V2 = { embedder: 'local-hash', model: 'feature-hash', modelVersion: '2', dimensions: 384 };
/** The migration target: the same embedder, model version 2; `before(texts)` runs before it answers. */
class Target extends DeterministicEmbedder {
  constructor(behavior = {}) { super({ ...V2, region: 'local' }); this.behavior = behavior; this.inputs = []; }
  async embed(texts, signal) {
    await this.behavior.before?.(texts);
    this.inputs.push(...texts);
    return super.embed(texts, signal);
  }
}
const registry = target => new EmbeddingRegistry([healthy, target]);
const generations = target => new PostgresProjectionGenerations(pool, { embedders: registry(target) });
const due = () => pool.query(`UPDATE projection_rebuilds SET available_at=clock_timestamp()-interval '1 second'
  WHERE phase IN ('backfill','verify')`);
/** Step until generation `number`'s rebuild finishes verification. */
async function settle(control, f, number, collectionId = 'alpha') {
  for (let tries = 0; tries < 30; tries++) {
    await due();
    await control.step({ budgetMs: 30_000 });
    const view = (await control.list(f.spaceId, collectionId)).find(entry => entry.generation === number);
    if (['verified', 'failed'].includes(view.rebuild.phase)) return view;
  }
  assert.fail('the rebuild never finished');
}
const states = async (control, f, collectionId = 'alpha') =>
  (await control.list(f.spaceId, collectionId)).map(view => [view.generation, view.state]);
const refs = async (f, generation) => (await pool.query(`SELECT ref_kind,ref_id,revision,extraction_version,deleted
  FROM projection_refs WHERE space_id=$1 AND collection_id='alpha' AND generation=$2 ORDER BY ref_kind,ref_id`, [f.spaceId, generation])).rows;
const lexical = async (f, generation) => (await pool.query(`SELECT ref_kind,ref_id,revision,extraction_version,chunk_index,field,
    content_start,content_end,content FROM lexical_chunks WHERE space_id=$1 AND collection_id='alpha' AND generation=$2
  ORDER BY ref_kind,ref_id,chunk_index`, [f.spaceId, generation])).rows;
const vectors = async (f, generation) => (await pool.query(`SELECT ref_kind,ref_id,revision,chunk_index,content_sha256,model_version
  FROM vector_chunks WHERE space_id=$1 AND collection_id='alpha' AND generation=$2 ORDER BY ref_kind,ref_id,chunk_index`,
[f.spaceId, generation])).rows;
const receipts = async (f, generation) => (await pool.query(`SELECT ref_kind,ref_id,chunks_removed FROM projection_deletion_receipts
  WHERE space_id=$1 AND collection_id='alpha' AND generation=$2 ORDER BY ref_kind,ref_id`, [f.spaceId, generation])).rows;
const rows = async (f, generation) => Object.fromEntries(await Promise.all(['lexical_chunks', 'vector_chunks', 'embedding_checkpoints',
  'projection_refs', 'projection_deletion_receipts'].map(async table => [table, (await pool.query(`SELECT count(*)::int AS n FROM ${table}
    WHERE space_id=$1 AND collection_id='alpha' AND generation=$2`, [f.spaceId, generation])).rows[0].n])));
const del = (f, recordId) => f.record('alpha', undefined, { recordId, expectedRevision: 1 }, 'delete');

test('a model migration rebuilds every canonical Ref from authority with its provenance, activates atomically and rolls back', async () => {
  const f = await fixture({ collections: ['alpha'] });
  const lantern = await f.record('alpha', { title: 'harbor lantern', note: 'The keeper lit the harbor lantern at dusk.' });
  await f.record('alpha', { title: 'harbor bell' });
  const ghost = await f.record('alpha', { title: 'harbor ghost' });
  const sourceId = await f.source('alpha', 'Harbor records describe the lantern keeper.');
  const { claimId } = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c1', statement: 'The harbor lantern burned oil.', attributedTo: 'log' });
  const gone = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c2', statement: 'The harbor had two lanterns.', attributedTo: 'log' });
  await index();
  // Deleted before the rebuild starts: neither may ever be live in the new generation.
  await del(f, ghost);
  await claims.delete(f.owner, f.spaceId, 'alpha', gone.claimId, { baseRevision: 1 });
  await index();
  const target = new Target();
  const control = generations(target);
  const before = await search(registry(target)).search(f.owner, f.spaceId, { query: 'harbor lantern' });

  const started = await control.start(f.spaceId, 'alpha', { embedder: V2 });
  assert.deepEqual([started.generation, started.state, started.embedder, started.rebuild.phase], [2, 'building', V2, 'backfill']);
  const verified = await settle(control, f, 2);
  assert.deepEqual([verified.state, verified.rebuild.phase, verified.rebuild.backfilled, verified.rebuild.mismatched],
    ['verifying', 'verified', 6, 0]);
  // Still searched: generation 1, until activation.
  assert.equal((await search(registry(target)).search(f.owner, f.spaceId, { query: 'harbor' })).collections[0].generation, 1);

  // Every canonical Ref at the same authoritative revision and extraction, deleted ones included; the same lexical
  // chunks and offsets; vectors of exactly the same texts, now from model version 2 only.
  assert.deepEqual(await refs(f, 2), await refs(f, 1));
  assert.deepEqual(await lexical(f, 2), await lexical(f, 1));
  const strip = list => list.map(({ model_version: _, ...rest }) => rest);
  assert.deepEqual(strip(await vectors(f, 2)), strip(await vectors(f, 1)));
  assert.deepEqual([...new Set((await vectors(f, 2)).map(row => row.model_version))], ['2']);
  assert.ok(target.inputs.includes('harbor lantern') && !target.inputs.some(text => text.includes('ghost') || text.includes('two lanterns')),
    'deleted content never reaches the new model');
  // Deleted before the rebuild: a receipt per generation, nothing removed in the new one because nothing was ever there.
  assert.deepEqual(await receipts(f, 2), [{ ref_kind: 'claim', ref_id: gone.claimId, chunks_removed: 0 },
    { ref_kind: 'record', ref_id: ghost, chunks_removed: 0 }]);

  const activated = await control.activate(f.spaceId, 'alpha', 2);
  assert.deepEqual(activated.map(view => [view.generation, view.state]), [[1, 'standby'], [2, 'active']]);
  const after = await search(registry(target)).search(f.owner, f.spaceId, { query: 'harbor lantern' });
  assert.equal(after.collections[0].generation, 2);
  assert.deepEqual(ids(after).sort(), ids(before).sort());
  assert.ok(after.results.every(hit => hit.citations.every(citation => !citation.matchedBy.includes('vector')
    || hit.provenance.embedder?.modelVersion === '2')));
  for (const id of [lantern, sourceId, claimId]) assert.ok(ids(after).some(entry => entry.endsWith(`/${id}`)), id);

  // The standby generation is still projected, so a rollback restores current content.
  const buoy = await f.record('alpha', { title: 'harbor buoy' });
  await index(registry(target));
  assert.deepEqual((await refs(f, 1)).find(row => row.ref_id === buoy)?.deleted, false);
  const rolled = await control.rollback(f.spaceId, 'alpha');
  assert.deepEqual(rolled.map(view => [view.generation, view.state]), [[1, 'active'], [2, 'retired']]);
  const restored = await search().search(f.owner, f.spaceId, { query: 'harbor buoy' });
  assert.equal(restored.collections[0].generation, 1);
  assert.ok(ids(restored).includes(`alpha/record/${buoy}`));

  // Retirement: later steps remove the retired generation's chunks and checkpoints; its Refs and receipts stay.
  const kept = await rows(f, 2);
  await control.step({ budgetMs: 10_000 });
  assert.deepEqual(await rows(f, 2), { ...kept, lexical_chunks: 0, vector_chunks: 0, embedding_checkpoints: 0 });
  assert.ok((await control.list(f.spaceId, 'alpha')).find(view => view.generation === 2).prunedAt);
  assert.ok((await rows(f, 1)).lexical_chunks > 0, 'the active generation keeps its chunks');
});

test('an interrupted rebuild resumes after the last Ref it finished, embedding nothing twice', async () => {
  const f = await fixture({ collections: ['alpha'] });
  const made = [];
  for (let n = 0; n < 60; n++) made.push(await f.record('alpha', { title: `item ${String(n).padStart(2, '0')} beacon` }));
  const titles = new Map(await Promise.all(made.map(async id => [id, (await pool.query(`SELECT data->>'title' AS t FROM records
    WHERE space_id=$1 AND record_id=$2`, [f.spaceId, id])).rows[0].t])));
  const sorted = [...made].sort((a, b) => (a < b ? -1 : 1));
  // The provider fails from its 30th call on: the step stops there and backs off.
  let calls = 0;
  const target = new Target({ before: () => { if (++calls >= 30 && !target.healed) throw new EmbedderUnavailableError('provider down'); } });
  const control = generations(target);
  await control.start(f.spaceId, 'alpha', { embedder: V2 });
  await control.step({ budgetMs: 30_000 });
  const stopped = (await control.list(f.spaceId, 'alpha'))[1].rebuild;
  // Verified against the collection's own key order: 29 Refs finished, the cursor on the last.
  const verified = await pool.query(`SELECT record_id FROM records WHERE space_id=$1 AND collection_id='alpha' ORDER BY record_id`, [f.spaceId]);
  assert.deepEqual(verified.rows.map(row => row.record_id), sorted);
  assert.deepEqual([stopped.phase, stopped.backfilled, stopped.cursor], ['backfill', 29, { kind: 'record', id: sorted[28] }]);
  assert.match(stopped.lastError, /EmbedderUnavailableError/);
  assert.ok(Date.parse(stopped.availableAt) > Date.now(), 'an outage backs the rebuild off');

  // A step that crashed holding the lease: nothing runs until the lease expires.
  await pool.query(`UPDATE projection_rebuilds SET available_at=clock_timestamp()+interval '1 hour' WHERE space_id=$1`, [f.spaceId]);
  assert.equal((await control.step({ budgetMs: 2_000 })).rebuilds, 0);
  target.healed = true;
  target.inputs = [];
  const view = await settle(control, f, 2);
  assert.deepEqual([view.rebuild.phase, view.rebuild.backfilled, view.rebuild.mismatched, view.rebuild.lastError], ['verified', 60, 0, null]);
  // Only the Refs after the cursor reached the provider again.
  assert.deepEqual(target.inputs.sort(), sorted.slice(29).map(id => titles.get(id)).sort());
  assert.equal((await vectors(f, 2)).length, 60);
});

test('a Ref deleted during the rebuild never becomes live in the new generation', async () => {
  const f = await fixture({ collections: ['alpha'] });
  const alpha = await f.record('alpha', { title: 'harbor alpha' });
  const beta = await f.record('alpha', { title: 'harbor beta' });
  const claim = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c', statement: 'A harbor claim.', attributedTo: 'x' });
  await index();
  let deletedAlpha = false;
  let deletedClaim = false;
  const target = new Target({ before: async texts => {
    // Authority deletes the record while its text is being embedded for the new generation: after the rebuild read
    // it live and before its apply commits.
    if (texts.includes('harbor alpha') && !deletedAlpha) { deletedAlpha = true; await del(f, alpha); }
    // The claim (claims come first in key order) is already in the new generation when this is embedded.
    if (texts.includes('harbor beta') && !deletedClaim) {
      deletedClaim = true;
      await claims.delete(f.owner, f.spaceId, 'alpha', claim.claimId, { baseRevision: 1 });
    }
  } });
  const control = generations(target);
  await control.start(f.spaceId, 'alpha', { embedder: V2 });
  const view = await settle(control, f, 2);
  assert.ok(deletedAlpha && deletedClaim);
  assert.deepEqual([view.rebuild.phase, view.rebuild.mismatched], ['verified', 0]);
  // Verification found the claim live and applied its deletion before passing.
  assert.equal(view.rebuild.repaired, 1);
  // Refs in key order: the claim, then the records by ID.
  const expected = [[claim.claimId, true], ...[[alpha, true], [beta, false]].sort(([a], [b]) => (a < b ? -1 : 1))];
  assert.deepEqual((await refs(f, 2)).map(row => [row.ref_id, row.deleted]), expected);
  assert.deepEqual(await receipts(f, 2), [{ ref_kind: 'claim', ref_id: claim.claimId, chunks_removed: 2 },
    { ref_kind: 'record', ref_id: alpha, chunks_removed: 0 }]);
  const chunks = await pool.query(`SELECT ref_id FROM lexical_chunks WHERE space_id=$1 AND generation=2 UNION ALL
    SELECT ref_id FROM vector_chunks WHERE space_id=$1 AND generation=2 UNION ALL
    SELECT ref_id FROM embedding_checkpoints WHERE space_id=$1 AND generation=2`, [f.spaceId]);
  assert.deepEqual([...new Set(chunks.rows.map(row => row.ref_id))], [beta]);
  // A late duplicate of the deleted record's old revision cannot bring it back: the worker leaves a deleted Ref alone.
  await index(registry(target));
  assert.deepEqual((await refs(f, 2)).map(row => [row.ref_id, row.deleted]), expected);
});

test('a failed verification leaves the previous generation active; a passed one activates and rollback restores the previous', async () => {
  const f = await fixture({ collections: ['alpha'] });
  await f.record('alpha', { title: 'harbor one' });
  await index();
  const target = new Target();
  const control = generations(target);
  await control.start(f.spaceId, 'alpha', { embedder: V2 });
  assert.equal((await settle(control, f, 2)).rebuild.phase, 'verified');
  // Written after the backfill, and not yet delivered: verification has to bring it in, and the new model refuses it.
  const poison = await f.record('alpha', { title: 'harbor poison' });
  const picky = new Target({ before: texts => { if (texts.some(text => text.includes('poison'))) throw new Error('refused input'); } });
  await generations(picky).reverify(f.spaceId, 'alpha', 2);
  const failed = await settle(generations(picky), f, 2);
  assert.deepEqual([failed.state, failed.rebuild.phase, failed.rebuild.mismatched, failed.rebuild.mismatches],
    ['verifying', 'failed', 1, [{ kind: 'record', id: poison, reason: 'failed' }]]);
  await rejects(control.activate(f.spaceId, 'alpha', 2), 'PRECONDITION_FAILED');
  assert.deepEqual(await states(control, f), [[1, 'active'], [2, 'verifying']]);
  assert.equal((await search(registry(target)).search(f.owner, f.spaceId, { query: 'harbor' })).collections[0].generation, 1);

  // Fixed: verification runs again, passes, and the generation activates.
  await control.reverify(f.spaceId, 'alpha', 2);
  const passed = await settle(control, f, 2);
  assert.deepEqual([passed.rebuild.phase, passed.rebuild.mismatched, passed.rebuild.repaired], ['verified', 0, 1]);
  await control.activate(f.spaceId, 'alpha', 2);
  assert.deepEqual(await states(control, f), [[1, 'standby'], [2, 'active']]);
  await control.rollback(f.spaceId, 'alpha');
  assert.deepEqual(await states(control, f), [[1, 'active'], [2, 'retired']]);
  await rejects(control.rollback(f.spaceId, 'alpha'), 'PRECONDITION_FAILED');
});

test('generation control refuses what would leave a collection without a safe active generation', async () => {
  const f = await fixture({ collections: ['alpha', 'beta'], policy: { beta: { vector: false } } });
  await f.record('alpha', { title: 'harbor one' });
  await f.record('beta', { title: 'harbor two' });
  await index();
  const target = new Target();
  const control = generations(target);
  // No configured embedder with that identity: nothing starts.
  await rejects(control.start(f.spaceId, 'alpha', { embedder: { ...V2, modelVersion: '9' } }), 'EMBEDDER_UNAVAILABLE');
  await rejects(new PostgresProjectionGenerations(pool).start(f.spaceId, 'alpha'), 'EMBEDDER_UNAVAILABLE');
  await rejects(control.start(f.spaceId, 'beta', { embedder: V2 }), 'INVALID_ARGUMENT');
  assert.deepEqual(await states(control, f), [[1, 'active']]);
  // One rebuild at a time per collection; an unverified generation never activates; the active one is not retired here.
  await control.start(f.spaceId, 'alpha', { embedder: V2 });
  await rejects(control.start(f.spaceId, 'alpha', { embedder: V2 }), 'CONFLICT');
  await rejects(control.activate(f.spaceId, 'alpha', 2), 'CONFLICT');
  await rejects(control.retire(f.spaceId, 'alpha', 1), 'CONFLICT');
  await rejects(control.rollback(f.spaceId, 'alpha'), 'PRECONDITION_FAILED');
  // Abandoned while building: the job never runs again, and the next rebuild takes a higher number.
  assert.equal((await control.retire(f.spaceId, 'alpha', 2)).state, 'retired');
  await due();
  assert.equal((await control.step({ budgetMs: 2_000 })).rebuilds, 0);
  assert.equal((await control.start(f.spaceId, 'alpha')).generation, 3);
  // A lexical-only policy rebuilds without an embedder.
  const lexicalOnly = await control.start(f.spaceId, 'beta');
  assert.equal(lexicalOnly.embedder, null);
  assert.equal((await settle(control, f, 2, 'beta')).rebuild.phase, 'verified');
  await control.activate(f.spaceId, 'beta', 2);
  assert.deepEqual(await states(control, f, 'beta'), [[1, 'standby'], [2, 'active']]);
  // A later activation retires the generation on standby: one fallback at a time.
  await control.start(f.spaceId, 'beta');
  await settle(control, f, 3, 'beta');
  await control.activate(f.spaceId, 'beta', 3);
  assert.deepEqual(await states(control, f, 'beta'), [[1, 'retired'], [2, 'standby'], [3, 'active']]);
  // A suspended space admits no control.
  await spaces.suspend(f.owner, f.spaceId);
  await rejects(control.rollback(f.spaceId, 'beta'), 'SPACE_UNAVAILABLE');
});
