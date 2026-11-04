import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresCandidates, PostgresRetrievalSearch } from '../../packages/postgres/dist/index.js';
import { DeterministicEmbedder, EmbeddingRegistry } from '../../packages/retrieval/dist/index.js';
import { authority, beacons, claims, config, fixture, healthy, hookedPool, identity, ids, index, LOCK_SPACE, lockWaited, pool,
  registry, rejects, REREAD, search, sources, spaces, Spy, target } from './retrieval-harness.js';

// STA-46: hybrid search over real projections, built by the STA-45 worker,
// with authority reread and reauthorization, on the shared retrieval
// harness, whose database this suite owns.
let hooks = [];
const hookedOn = base => hookedPool(base, () => hooks, hook => { hooks = hooks.filter(item => item !== hook); });
const hooked = hookedOn(pool);
const PLAN = "s.method='exact'";
const ADMISSION = 's.placement_generation=$3';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessionExpiry = (owner, expiresAt) => config.database.update({ model: 'sessions', where: [{ field: 'id', operator: 'eq',
  value: owner.credentialId }], data: { expiresAt }, namespace: config.namespace });

test('hybrid search returns fused, deduplicated, cited and fresh hits from authority', async () => {
  const f = await fixture();
  const lantern = await f.record('alpha', { title: 'The harbor lantern was lit at dusk', note: 'a lantern by the harbor' });
  const other = await f.record('alpha', { title: 'Grain prices rose in spring' });
  const sourceId = await f.source('beta', 'Harbor records describe the lantern keeper and the lantern tower.');
  const claim = await claims.create(f.owner, f.spaceId, 'beta', { idempotencyKey: 'c1', statement: 'The harbor lantern burned whale oil.',
    attributedTo: 'harbor log', evidence: [{ collectionId: 'beta', sourceId }] });
  await claims.review(f.owner, f.spaceId, 'beta', claim.claimId, { baseRevision: 1, status: 'accepted' });
  await index();

  healthy.queries.length = 0;
  const result = await search().search(f.owner, f.spaceId, { query: 'harbor lantern' });
  assert.deepEqual(healthy.queries, ['harbor lantern'], 'one query embedding per identity and region');
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.state, 'current');
  assert.equal(result.complete, false);
  assert.deepEqual(result.collections.map(entry => [entry.collectionId, entry.generation, entry.lexical, entry.vector, entry.projection]),
    [['alpha', 1, true, 'used', 'current'], ['beta', 1, true, 'used', 'current']]);
  // Each Ref once, however many of its chunks and lists matched; the unrelated record is not a lexical match.
  assert.equal(new Set(ids(result)).size, result.results.length);
  for (const key of [`alpha/record/${lantern}`, `beta/source/${sourceId}`, `beta/claim/${claim.claimId}`]) assert.ok(ids(result).includes(key), key);
  const hit = result.results.find(entry => entry.ref.id === lantern);
  assert.equal(hit.revision, 1);
  assert.ok(hit.provenance.lexicalRank >= 1 && hit.provenance.vectorRank >= 1, 'found by both lists');
  assert.deepEqual(hit.provenance.embedder, { embedder: 'local-hash', model: 'feature-hash', modelVersion: '1', dimensions: 384 });
  assert.equal(hit.provenance.generation, 1);
  assert.equal(hit.review, null);
  assert.equal(hit.freshness.projection, 'current');
  assert.ok(Date.parse(hit.freshness.verifiedAt) > 0);
  // Citations are the authoritative text at the chunk's offsets.
  for (const citation of hit.citations) {
    const field = { '/title': 'The harbor lantern was lit at dusk', '/note': 'a lantern by the harbor' }[citation.field];
    assert.equal(citation.text, [...field].slice(citation.start, citation.end).join(''));
  }
  const claimHit = result.results.find(entry => entry.ref.kind === 'claim');
  assert.equal(claimHit.revision, 2, 'the reviewed revision');
  assert.equal(claimHit.review.status, 'accepted');
  assert.equal(claimHit.provenance.attributedTo, 'harbor log');
  assert.deepEqual(claimHit.provenance.evidence, [{ collectionId: 'beta', sourceId, extractionVersion: null, start: null, end: null }]);
  // One chunk found by both lists is one citation that names both, and keeps the vector match's embedder.
  assert.deepEqual(claimHit.citations.map(citation => [citation.text, citation.matchedBy]),
    [['The harbor lantern burned whale oil.', ['lexical', 'vector']]]);
  assert.ok(claimHit.provenance.lexicalRank >= 1 && claimHit.provenance.vectorRank >= 1);
  assert.equal(claimHit.provenance.embedder?.embedder, 'local-hash');
  const sourceHit = result.results.find(entry => entry.ref.kind === 'source');
  assert.equal(sourceHit.extractionVersion, 1);
  assert.equal(sourceHit.citations[0].text, 'Harbor records describe the lantern keeper and the lantern tower.');
  assert.ok(result.underfill === null || result.underfill.returned === result.results.length);
  assert.ok(!ids(result).includes(`alpha/record/${other}`) || result.results.at(-1).provenance.lexicalRank === null,
    'an unrelated record can only trail as a vector neighbour');

  // Collection and kind filters.
  const only = await search().search(f.owner, f.spaceId, { query: 'harbor lantern', collections: ['beta'], kinds: ['claim'] });
  assert.deepEqual(ids(only), [`beta/claim/${claim.claimId}`]);
  await rejects(search().search(f.owner, f.spaceId, { query: 'harbor', collections: ['missing'] }), 'NOT_FOUND');
  for (const bad of [{}, { query: ' ' }, { query: 'x', limit: 51 }, { query: 'x', kinds: ['link'] }, { query: 'x'.repeat(1001) },
    { query: 'x', collections: [] }, { query: 'x', extra: 1 }])
    await rejects(search().search(f.owner, f.spaceId, bad), 'INVALID_ARGUMENT');
});

test('deleted, tombstoned and stale hits are rejected at reread, never returned', async () => {
  const f = await fixture();
  const { kept, deleted, revised, sourceId, corrected, claim } = await beacons(f);
  assert.equal((await search().search(f.owner, f.spaceId, { query: 'beacon' })).results.length, 6);

  // Authority moves on; the projections are not delivered yet, so they still hold every old chunk.
  await f.record('alpha', undefined, { recordId: deleted, expectedRevision: 1 }, 'delete');
  await f.record('alpha', { title: 'lighthouse three' }, { recordId: revised, expectedRevision: 1 }, 'replace');
  await sources.delete(f.owner, f.spaceId, 'alpha', sourceId);
  await sources.correctExtraction(f.owner, f.spaceId, 'alpha', corrected, { baseVersion: 1, content: 'Another lighthouse source.', sourceOffsets: [] });
  await claims.delete(f.owner, f.spaceId, 'alpha', claim.claimId, { baseRevision: 1 });
  const stale = await search().search(f.owner, f.spaceId, { query: 'beacon' });
  assert.deepEqual(ids(stale), [`alpha/record/${kept}`]);
  // Content authority no longer holds is no candidate at all, so no count or rank discloses that it matched.
  assert.equal(stale.candidates.lexical, 1);
  assert.equal(stale.candidates.vector, 1, 'only the live record is a vector neighbour');
  assert.deepEqual(stale.rejected, { deleted: 0, stale: 0, unauthorized: 0 });
  assert.equal(stale.state, 'pending', 'undelivered work is reported');
  // A short vector list proves nothing (the filtered index scan may stop early), so the result is never exhausted.
  assert.deepEqual(stale.underfill, { returned: 1, requested: 10, reasons: ['approximate', 'pending'] });

  // Once delivered, the new text is found and the old is gone.
  await index();
  const current = await search().search(f.owner, f.spaceId, { query: 'lighthouse' });
  // The lexical matches lead; the vector list may add unrelated nearest neighbours after them.
  assert.deepEqual(new Set(ids(current).slice(0, 2)), new Set([`alpha/record/${revised}`, `alpha/source/${corrected}`]));
  assert.ok(current.results.slice(2).every(hit => hit.provenance.lexicalRank === null));
  assert.equal(current.results.find(hit => hit.ref.id === revised).revision, 2);
  assert.equal(current.results.find(hit => hit.ref.id === corrected).extractionVersion, 2);
  assert.deepEqual((await search().search(f.owner, f.spaceId, { query: 'beacon' })).rejected, { deleted: 0, stale: 0, unauthorized: 0 });
});

test('a deletion or revision committed after the candidates are read is caught by the fresh reread', async () => {
  const f = await fixture();
  const deleted = await f.record('alpha', { title: 'compass rose' });
  const revised = await f.record('alpha', { title: 'compass needle' });
  const deletedSource = await f.source('alpha', 'A compass survey.');
  const corrected = await f.source('alpha', 'A compass bearing.');
  const claim = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: randomUUID(), statement: 'The compass points north.',
    attributedTo: 'navigator' });
  await index();
  assert.equal((await search().search(f.owner, f.spaceId, { query: 'compass' })).results.length, 5);
  hooks = [{ match: REREAD, run: async () => {
    await f.record('alpha', undefined, { recordId: deleted, expectedRevision: 1 }, 'delete');
    await f.record('alpha', { title: 'compass needle, recalibrated' }, { recordId: revised, expectedRevision: 1 }, 'replace');
    await sources.delete(f.owner, f.spaceId, 'alpha', deletedSource);
    await sources.correctExtraction(f.owner, f.spaceId, 'alpha', corrected, { baseVersion: 1, content: 'A compass heading.',
      sourceOffsets: [] });
    await claims.delete(f.owner, f.spaceId, 'alpha', claim.claimId, { baseRevision: 1 });
  } }];
  const result = await search(registry, hooked).search(f.owner, f.spaceId, { query: 'compass' });
  assert.equal(hooks.length, 0);
  assert.deepEqual(result.results, []);
  // The record, source and claim tombstones are deleted; the record's new revision and the source's new extraction are stale.
  assert.deepEqual(result.rejected, { deleted: 3, stale: 2, unauthorized: 0 });
  assert.equal(result.underfill.returned, 0, 'reported, never padded');
});

test('a match the reread rejects as stale neither ranks nor boosts its Ref: ranks and score come from surviving matches', async () => {
  const f = await fixture({ collections: ['alpha'] });
  const both = await f.record('alpha', { title: 'heron at the pond' });
  const revised = await f.record('alpha', { title: 'heron' });
  const corrected = await f.source('alpha', 'A heron survey.');
  await index();
  // Between the vector and the lexical statement a new revision and a new extraction are indexed, so the vector list
  // holds their superseded chunks and the lexical list their current ones.
  hooks = [{ match: 'websearch_to_tsquery', run: async () => {
    await f.record('alpha', { title: 'heron' }, { recordId: revised, expectedRevision: 1 }, 'replace');
    await sources.correctExtraction(f.owner, f.spaceId, 'alpha', corrected, { baseVersion: 1, content: 'A heron census.',
      sourceOffsets: [] });
    await index();
  } }];
  const result = await search(registry, hooked).search(f.owner, f.spaceId, { query: 'heron' });
  assert.equal(hooks.length, 0);
  assert.equal(result.candidates.considered, 3);
  assert.deepEqual(result.rejected, { deleted: 0, stale: 0, unauthorized: 0 }, 'each keeps its current lexical citation');
  const hit = id => result.results.find(item => item.ref.id === id);
  for (const [id, revision, extractionVersion] of [[revised, 2, null], [corrected, 1, 2]]) {
    const stale = hit(id);
    assert.deepEqual([stale.revision, stale.extractionVersion], [revision, extractionVersion]);
    assert.deepEqual(stale.citations.map(citation => citation.matchedBy), [['lexical']]);
    assert.equal(stale.provenance.vectorRank, null, 'the superseded vector match has no rank');
    assert.equal(stale.provenance.embedder, null);
    assert.equal(stale.score, 1 / (60 + stale.provenance.lexicalRank), 'a single-list score');
  }
  // The Ref both lists found current outranks every Ref left with one list, and the page is in score order.
  const fresh = hit(both);
  assert.deepEqual(ids(result)[0], `alpha/record/${both}`);
  assert.equal(fresh.score, 1 / (60 + fresh.provenance.lexicalRank) + 1 / (60 + fresh.provenance.vectorRank));
  assert.equal(fresh.provenance.vectorRank, 1, 'ranks are fused again over the surviving matches');
  assert.deepEqual(result.results.map(item => item.score), result.results.map(item => item.score).sort((a, b) => b - a));
});

test("an owner's claim is fenced on every collection it cites, also outside the search filter", async () => {
  const f = await fixture();
  const cited = await f.source('beta', 'A tide table.');
  const make = () => claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: randomUUID(), statement: 'The tide turns at noon.',
    attributedTo: 'harbor master', evidence: [{ collectionId: 'beta', sourceId: cited }] });
  const claim = await make();
  await index();
  const request = { query: 'tide', collections: ['alpha'], kinds: ['claim'] };
  assert.deepEqual(ids(await search().search(f.owner, f.spaceId, request)), [`alpha/claim/${claim.claimId}`]);
  const deleteBeta = () => pool.query("UPDATE collections SET lifecycle='deleted' WHERE space_id=$1 AND collection_id='beta'",
    [f.spaceId]);

  // Deleted after the reread read beta live, before the cited collections are locked: the locked row decides, so excluded.
  hooks = [{ match: 'SELECT collection_id,lifecycle FROM collections', run: deleteBeta }];
  const excluded = await search(registry, hooked).search(f.owner, f.spaceId, request);
  assert.equal(hooks.length, 0);
  assert.deepEqual(excluded.results, []);
  assert.deepEqual(excluded.rejected, { deleted: 0, stale: 0, unauthorized: 1 });

  // Deleted during the final provider check: the deletion waits for the search's commit, so the returned claim was current.
  const g = await fixture();
  const source = await g.source('beta', 'A tide table.');
  const held = await claims.create(g.owner, g.spaceId, 'alpha', { idempotencyKey: randomUUID(), statement: 'The tide turns at noon.',
    attributedTo: 'harbor master', evidence: [{ collectionId: 'beta', sourceId: source }] });
  await index();
  const order = [];
  let deletion;
  const provider = { scope: (...args) => spaces.scope(...args), assertCurrentUntil: async (...args) => {
    let done = false;
    deletion = pool.query("UPDATE collections SET lifecycle='deleted' WHERE space_id=$1 AND collection_id='beta'", [g.spaceId])
      .then(() => { done = true; order.push('deleted'); });
    for (let tries = 0; !done; tries++) {
      const waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock'`)).rows[0].n;
      if (waiting) break;
      assert.ok(tries < 400, 'the deletion either waits or completes');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return spaces.assertCurrentUntil(...args);
  } };
  // Lexical only, so the final check is the only provider check.
  const fenced = await new PostgresRetrievalSearch(provider, new Map([['cell-a', { pool }]]), { embedders: new EmbeddingRegistry() })
    .search(g.owner, g.spaceId, request);
  order.push('searched');
  await deletion;
  assert.deepEqual(order, ['searched', 'deleted'], 'the deletion waited for the search');
  assert.deepEqual(ids(fenced), [`alpha/claim/${held.claimId}`]);
  assert.deepEqual((await search().search(g.owner, g.spaceId, request)).results, []);
});

test('search reads only granted collections and kinds, and applies the claim read rule', async () => {
  const f = await fixture();
  await f.record('alpha', { title: 'orchard ledger' });
  await f.record('beta', { title: 'orchard map' });
  const betaSource = await f.source('beta', 'The orchard survey.');
  const citing = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c1', statement: 'The orchard was surveyed.',
    attributedTo: 'survey', evidence: [{ collectionId: 'beta', sourceId: betaSource }] });
  const plain = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c2', statement: 'The orchard has apples.',
    attributedTo: 'farmer' });
  await index();

  const recordsOnly = await f.agent([['alpha', ['records:read']]]);
  const result = await search().search(recordsOnly, f.spaceId, { query: 'orchard' });
  assert.deepEqual(result.collections.map(entry => entry.collectionId), ['alpha']);
  assert.deepEqual(result.results.map(hit => [hit.ref.collectionId, hit.ref.kind]), [['alpha', 'record']]);
  await rejects(search().search(recordsOnly, f.spaceId, { query: 'orchard', collections: ['beta'] }), 'NOT_FOUND');
  await rejects(search().search(recordsOnly, f.spaceId, { query: 'orchard', kinds: ['claim'] }), 'FORBIDDEN');

  // A claim citing a collection whose sources the key cannot read does not exist for it.
  const claimsOnly = await f.agent([['alpha', ['claims:read']]]);
  const visible = await search().search(claimsOnly, f.spaceId, { query: 'orchard' });
  assert.deepEqual(ids(visible), [`alpha/claim/${plain.claimId}`]);
  assert.deepEqual(visible.rejected, { deleted: 0, stale: 0, unauthorized: 0 });
  assert.deepEqual(visible.candidates, { lexical: 1, vector: 1, considered: 1 });
  // A term only the hidden claim holds yields exactly what a term nothing holds does: no count, rank or reason differs.
  const summary = result => ({ ids: ids(result), candidates: result.candidates, rejected: result.rejected, underfill: result.underfill,
    lexicalRanks: result.results.map(hit => hit.provenance.lexicalRank) });
  const hidden = await search().search(claimsOnly, f.spaceId, { query: 'surveyed', collections: ['alpha'], kinds: ['claim'] });
  const nothing = await search().search(claimsOnly, f.spaceId, { query: 'zymurgy', collections: ['alpha'], kinds: ['claim'] });
  assert.deepEqual(summary(hidden), summary(nothing));
  assert.equal(hidden.candidates.lexical, 0);
  const both = await f.agent([['alpha', ['claims:read']], ['beta', ['sources:read']]]);
  assert.deepEqual(new Set(ids(await search().search(both, f.spaceId, { query: 'orchard' }))),
    new Set([`alpha/claim/${plain.claimId}`, `alpha/claim/${citing.claimId}`, `beta/source/${betaSource}`]));
});

test('projection state counts only work of kinds the caller searches and may read, and claims under the read rule', async () => {
  const f = await fixture();
  const cited = await f.source('beta', 'The tide survey.');
  await index();
  const claimsOnly = await f.agent([['alpha', ['claims:read']]]);
  const withEvidence = await f.agent([['alpha', ['claims:read']], ['beta', ['sources:read']]]);
  const meta = result => ({ mode: result.mode, state: result.state, collections: result.collections, underfill: result.underfill,
    candidates: result.candidates, rejected: result.rejected });
  const before = meta(await search().search(claimsOnly, f.spaceId, { query: 'tide' }));
  assert.equal(before.state, 'current');

  // Record work the key cannot read, and a claim it cannot see (it cites beta, whose sources the key cannot read), wait.
  const record = await f.record('alpha', { title: 'tide table' });
  await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: randomUUID(), statement: 'The tide turns at noon.',
    attributedTo: 'harbor', evidence: [{ collectionId: 'beta', sourceId: cited }] });
  const state = async (actor, request = {}) => {
    const result = await search().search(actor, f.spaceId, { query: 'tide', collections: ['alpha'], ...request });
    return [result.state, result.collections[0].projection, result.underfill?.reasons.filter(reason => reason === 'pending') ?? []];
  };
  assert.deepEqual(meta(await search().search(claimsOnly, f.spaceId, { query: 'tide' })), before, 'nothing it cannot read shows');
  assert.deepEqual(await state(f.owner), ['pending', 'pending', ['pending']]);
  assert.deepEqual(await state(f.owner, { kinds: ['source'] }), ['current', 'current', []], 'only searched kinds count');
  assert.deepEqual(await state(withEvidence), ['pending', 'pending', ['pending']], 'the claim it may read is waiting');

  // Failures: a failed record delivery and an error on the hidden claim's job.
  await pool.query(`UPDATE projection_outbox SET failures=1,last_error='projection failed'
    WHERE space_id=$1 AND collection_id='alpha' AND record_id=$2`, [f.spaceId, record]);
  assert.deepEqual(meta(await search().search(claimsOnly, f.spaceId, { query: 'tide' })), before);
  assert.deepEqual((await state(f.owner, { kinds: ['record'] })).slice(0, 2), ['degraded', 'degraded']);
  assert.deepEqual(await state(withEvidence), ['pending', 'pending', ['pending']]);
  await pool.query(`UPDATE retrieval_outbox SET attempts=attempts+1,last_error='indexing failed'
    WHERE space_id=$1 AND collection_id='alpha' AND ref_kind='claim' AND delivery_state='pending'`, [f.spaceId]);
  assert.deepEqual(meta(await search().search(claimsOnly, f.spaceId, { query: 'tide' })), before);
  assert.deepEqual((await state(withEvidence)).slice(0, 2), ['degraded', 'degraded']);
});

/** Let `key`'s grant on `collectionId` lapse now, as an expiry does: no API call, no policy version change. */
const expire = (spaceId, key, collectionId) => pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()
  WHERE space_id=$1 AND credential_id=$2 AND collection_id=$3`, [spaceId, key.credentialId, collectionId]);

test('a revocation committed before the reread fails the search; one committed during it waits for its commit', async () => {
  const f = await fixture();
  await f.record('alpha', { title: 'kestrel nest' });
  await index();
  const key = await f.agent([['alpha', ['records:read']]]);
  hooks = [{ match: LOCK_SPACE, run: () => spaces.revokeAgentKey(f.owner, f.spaceId, key.keyId) }];
  await rejects(search(registry, hooked).search(key, f.spaceId, { query: 'kestrel' }), 'FORBIDDEN');
  await rejects(search().search(key, f.spaceId, { query: 'kestrel' }), 'NOT_FOUND');

  // A grant that lapses between the plan and the reread narrows the access the candidates were read under: no counts.
  const expiring = await f.agent([['alpha', ['records:read']], ['beta', ['records:read']]]);
  hooks = [{ match: LOCK_SPACE, run: () => expire(f.spaceId, expiring, 'alpha') }];
  await rejects(search(registry, hooked).search(expiring, f.spaceId, { query: 'kestrel' }), 'FORBIDDEN');
  assert.equal(hooks.length, 0);

  // Revoking while the reread holds its locks waits, so what the search returns was authorized at its commit.
  const holder = await f.agent([['alpha', ['records:read']]]);
  const order = [];
  let revocation;
  hooks = [{ match: REREAD, run: async () => {
    revocation = spaces.revokeAgentKey(f.owner, f.spaceId, holder.keyId).then(() => order.push('revoked'));
    await lockWaited('the revocation waits on the search');
  } }];
  const held = await search(registry, hooked).search(holder, f.spaceId, { query: 'kestrel' });
  order.push('searched');
  await revocation;
  assert.equal(held.results.length, 1);
  assert.deepEqual(order, ['searched', 'revoked']);
  await rejects(search().search(holder, f.spaceId, { query: 'kestrel' }), 'NOT_FOUND');
});

test('a grant lapsing after the plan, before either candidate statement, fails the search instead of counting new content', async () => {
  // Each statement in turn is the only one that can see the content: lexical is off for the vector case.
  for (const [statement, match, lexical] of [['lexical', 'websearch_to_tsquery', true], ['vector', 'hnsw.iterative_scan', false]]) {
    // The searched collection's own read grant lapses; then matching content is written and indexed there.
    const f = await fixture({ policy: { alpha: { lexical } } });
    await f.record('beta', { title: 'unrelated' });
    await index();
    const key = await f.agent([['alpha', ['records:read']], ['beta', ['records:read']]]);
    let written = false;
    hooks = [{ match, run: async () => {
      await expire(f.spaceId, key, 'alpha');
      await f.record('alpha', { title: 'sandpiper flock' });
      await index();
      written = true;
    } }];
    await rejects(search(registry, hooked).search(key, f.spaceId, { query: 'sandpiper' }), 'FORBIDDEN');
    assert.ok(written, `${statement}: the content was written and indexed in the window`);

    // An evidence collection's sources:read lapses; then a claim citing it is written and indexed in the searched one.
    const g = await fixture({ policy: { alpha: { lexical } } });
    const cited = await g.source('beta', 'A shore survey.');
    await index();
    const reader = await g.agent([['alpha', ['claims:read']], ['beta', ['sources:read']]]);
    written = false;
    hooks = [{ match, run: async () => {
      await expire(g.spaceId, reader, 'beta');
      await claims.create(g.owner, g.spaceId, 'alpha', { idempotencyKey: randomUUID(), statement: 'Sandpipers nest on the shore.',
        attributedTo: 'survey', evidence: [{ collectionId: 'beta', sourceId: cited }] });
      await index();
      written = true;
    } }];
    await rejects(search(registry, hooked).search(reader, g.spaceId, { query: 'sandpipers', collections: ['alpha'] }), 'FORBIDDEN');
    assert.ok(written, `${statement}: the claim was written and indexed in the window`);
  }
});

test('a relied-on grant expiring during the final provider check fails the search', async () => {
  const f = await fixture({ collections: ['alpha'] });
  await f.record('alpha', { title: 'osprey dive' });
  await index();
  const key = await f.agent([['alpha', ['records:read']]]);
  // The grant is live through the plan, the embedding call, the candidates and the reread; it lapses on its own while the
  // final provider check is awaited.
  const { searcher, state } = lapsingDuringProviderCheck(f, key, 'alpha');
  await rejects(searcher.search(key, f.spaceId, { query: 'osprey' }), 'FORBIDDEN');
  assert.ok(state.reached, 'the reread admitted the hit; the final check refused it');
});

test('an embedder or vector outage returns lexical results marked degraded while exact reads work', async () => {
  const f = await fixture({ collections: ['alpha', 'beta'], policy: { beta: { lexical: false } } });
  const id = await f.record('alpha', { title: 'heron migration' });
  await f.record('beta', { title: 'heron vectors only' });
  await index();

  for (const [embedders, error] of [[new EmbeddingRegistry([new Spy({ down: true })]), 'EMBEDDER_UNAVAILABLE'],
    [new EmbeddingRegistry([new Spy({ hang: true })]), 'EMBEDDER_UNAVAILABLE'],
    [new EmbeddingRegistry([new Spy({ fail: true })]), 'EMBEDDER_FAILED'], [new EmbeddingRegistry(), 'EMBEDDER_NOT_CONFIGURED']]) {
    const started = Date.now();
    const result = await search(embedders).search(f.owner, f.spaceId, { query: 'heron' });
    assert.ok(Date.now() - started < 4_000, 'an embedder that never answers is not waited for past its 2 s bound');
    assert.equal(result.mode, 'lexical');
    assert.equal(result.state, 'degraded');
    assert.deepEqual(result.collections.map(entry => [entry.collectionId, entry.lexical, entry.vector, entry.vectorError]),
      [['alpha', true, 'unavailable', error], ['beta', false, 'unavailable', error]]);
    assert.deepEqual(ids(result), [`alpha/record/${id}`], 'the lexical side still answers');
    assert.equal(result.results[0].provenance.vectorRank, null);
    // The vector side (and beta altogether) went unsearched, so the short result is never exhausted.
    assert.deepEqual(result.underfill.reasons, ['degraded']);
  }
  // The vector query itself failing is the same degradation.
  hooks = [{ match: 'hnsw.iterative_scan', run: async client => { await client.query('SELECT 1/0'); } }];
  const failed = await search(registry, hooked).search(f.owner, f.spaceId, { query: 'heron' });
  assert.deepEqual(failed.collections.map(entry => entry.vectorError), ['VECTOR_QUERY_FAILED', 'VECTOR_QUERY_FAILED']);
  assert.deepEqual(ids(failed), [`alpha/record/${id}`]);
  assert.deepEqual(failed.underfill.reasons, ['degraded']);
  // Exact reads never depend on search or its embedder.
  assert.equal((await authority.transaction({ ...f.scope('alpha'), capability: 'records:read' }, tx => tx.getRecord(id))).ref.id, id);
  // Healthy again: the vector-only collection answers too.
  assert.equal((await search().search(f.owner, f.spaceId, { query: 'heron' })).results.length, 2);
});

test('underfill after filtering is explicit and bounded overfetch never pads', async () => {
  const f = await fixture({ collections: ['alpha'] });
  const made = [];
  for (let i = 0; i < 25; i++) made.push(await f.record('alpha', { title: `quarry stone ${i}` }));
  await index();
  // Every match is deleted after the candidates were read, so the reread rejects every one.
  hooks = [{ match: REREAD, run: async () => {
    for (const id of made) await f.record('alpha', undefined, { recordId: id, expectedRevision: 1 }, 'delete');
  } }];
  const result = await search(registry, hooked).search(f.owner, f.spaceId, { query: 'quarry', limit: 1 });
  assert.deepEqual(result.results, []);
  assert.equal(result.candidates.considered, 20, 'the overfetch bound for limit 1');
  assert.equal(result.rejected.deleted, 20);
  assert.deepEqual(result.underfill, { returned: 0, requested: 1, reasons: ['rejected', 'bounded'] });
});

test('a short result is exhausted only when every list was exact and every readable collection was searched', async () => {
  const names = Array.from({ length: 33 }, (_, i) => `c${String(i).padStart(2, '0')}`);
  const f = await fixture({ collections: names, policy: Object.fromEntries(names.map(id => [id, { vector: false }])) });
  await f.record('c00', { title: 'tidepool survey' });
  await index();
  const capped = await search().search(f.owner, f.spaceId, { query: 'tidepool' });
  assert.equal(capped.collectionsCapped, true);
  assert.equal(capped.collections.length, 32);
  assert.equal(capped.results.length, 1);
  assert.deepEqual(capped.underfill.reasons, ['capped'], 'an unsearched collection may hold more');
  const listed = await search().search(f.owner, f.spaceId, { query: 'tidepool', collections: ['c00', 'c32'] });
  assert.equal(listed.collectionsCapped, false);
  assert.deepEqual(listed.underfill.reasons, ['exhausted'], 'every searched list was lexical and returned all it had');
  assert.deepEqual(listed.collections.map(entry => entry.unsearched), [[], []], 'every requested kind is projected and searched');
});

test('a collection no list ran over is reported unsearched, never exhausted', async () => {
  // beta's policy enables neither list: its matching record was never searched.
  const f = await fixture({ collections: ['alpha', 'beta'], policy: { alpha: { vector: false }, beta: { lexical: false, vector: false } } });
  const kelp = await f.record('alpha', { title: 'kelp forest' });
  await f.record('beta', { title: 'kelp forest' });
  await index();
  const both = await search().search(f.owner, f.spaceId, { query: 'kelp' });
  assert.deepEqual(ids(both), [`alpha/record/${kelp}`]);
  assert.deepEqual(both.collections.map(entry => [entry.collectionId, entry.lexical, entry.vector, entry.projection, entry.unsearched]),
    [['alpha', true, 'disabled', 'current', []], ['beta', false, 'disabled', 'current', ['record', 'source', 'claim']]]);
  assert.deepEqual(both.underfill.reasons, ['unprojected']);
  const alone = await search().search(f.owner, f.spaceId, { query: 'kelp', collections: ['alpha'] });
  assert.deepEqual(alone.underfill.reasons, ['exhausted'], 'alpha alone was covered');
});

test('a requested readable kind the policy does not project is reported unsearched, never exhausted', async () => {
  // A policy that projects no sources: a matching source was never searched, whatever records and claims were.
  const g = await fixture({ collections: ['alpha'], policy: { alpha: { vector: false, sources: false } } });
  const note = await g.record('alpha', { title: 'saltmarsh census' });
  await g.source('alpha', 'saltmarsh tides and the census of herons');
  await index();
  const all = await search().search(g.owner, g.spaceId, { query: 'saltmarsh' });
  assert.deepEqual(ids(all), [`alpha/record/${note}`]);
  assert.deepEqual(all.collections.map(entry => entry.unsearched), [['source']]);
  assert.deepEqual(all.underfill.reasons, ['unprojected']);
  // Asking only for kinds the policy projects is covered again; a key that cannot read sources is not told about them.
  const records = await search().search(g.owner, g.spaceId, { query: 'saltmarsh', kinds: ['record', 'claim'] });
  assert.deepEqual(records.collections.map(entry => entry.unsearched), [[]]);
  assert.deepEqual(records.underfill.reasons, ['exhausted']);
  const key = await g.agent([['alpha', ['records:read', 'claims:read']]]);
  const keyed = await search().search(key, g.spaceId, { query: 'saltmarsh' });
  assert.deepEqual(keyed.collections.map(entry => entry.unsearched), [[]]);
  assert.deepEqual(keyed.underfill.reasons, ['exhausted']);
});

test('a filtered nearest-neighbour query keeps scanning the HNSW index past other spaces', async () => {
  // Noise in another space sits nearer the query than every target chunk, so an unfiltered top-k is all noise.
  const noise = await fixture({ collections: ['alpha'], policy: { alpha: { lexical: false } } });
  for (let i = 0; i < 40; i++) await noise.record('alpha', { title: `falcon falcon falcon ${i}` });
  const f = await fixture({ collections: ['alpha'], policy: { alpha: { lexical: false } } });
  const wanted = [];
  for (let i = 0; i < 6; i++) wanted.push(await f.record('alpha', { title: `falcon tower stairs number ${i}` }));
  await index();
  const generations = [{ collectionId: 'alpha', generation: 1, textSearchConfig: 'english', kinds: ['record'] }];
  const vector = healthy.vector('falcon');
  const model = { embedder: 'local-hash', model: 'feature-hash', modelVersion: '1', dimensions: 384 };
  // Prefer the index's order over sorting, so the plan is the filtered ANN scan this test is about.
  const planned = { connect: async () => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    client.query = (sql, ...rest) => typeof sql === 'string' && sql.startsWith('SET LOCAL hnsw.ef_search')
      ? query('SET LOCAL enable_sort = off').then(() => query(sql, ...rest)) : query(sql, ...rest);
    const release = client.release.bind(client);
    client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
    return client;
  } };
  const found = await new PostgresCandidates(planned).nearest({ spaceId: f.spaceId, generations, evidenceCollections: null },
    model, vector, 20);
  assert.deepEqual(new Set(found.map(hit => hit.id)), new Set(wanted), 'every target chunk, none of the noise');

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL enable_sort = off');
    await db.query('SET LOCAL hnsw.ef_search = 20');
    const sql = `SELECT ref_id FROM vector_chunks v WHERE space_id=$1 AND collection_id='alpha' AND generation=1 AND dimensions=384
      ORDER BY (embedding::vector(384)) <=> $2::vector(384) LIMIT 20`;
    const plan = (await db.query(`EXPLAIN ${sql}`, [f.spaceId, `[${vector}]`])).rows.map(row => row['QUERY PLAN']).join('\n');
    assert.match(plan, /vector_chunks_hnsw_384/);
    // Without the iterative scan the same filtered top-k comes back short: it is never complete by itself.
    await db.query('SET LOCAL hnsw.iterative_scan = off');
    assert.ok((await db.query(sql, [f.spaceId, `[${vector}]`])).rows.length < wanted.length);
  } finally { await db.query('ROLLBACK'); db.release(); }
});

test('a policy narrowing committed during one embedding call stops the next group before its query leaves', async () => {
  const f = await fixture({ policy: { beta: { regions: ['eu'] } } });
  const local = new Spy();
  const eu = new Spy({}, 'eu');
  const both = new EmbeddingRegistry([local, eu]);
  const alpha = await f.record('alpha', { title: 'osprey dive' });
  await f.record('beta', { title: 'osprey perch' });
  await index(both);
  eu.queries.length = 0;
  // While alpha's group embeds in `local`, beta's current policy drops `eu`, the only region its generation's policy allows.
  local.behavior.before = async () => {
    local.behavior.before = undefined;
    await pool.query(`INSERT INTO retrieval_policies(space_id,collection_id,version,record_fields,source_content,claim_statements,
        lexical,vector,text_search_config,processing_regions,credential_id)
      VALUES($1,'beta',2,'{/title,/note}',true,true,true,true,'english','{local}','owner')`, [f.spaceId]);
  };
  const result = await search(both).search(f.owner, f.spaceId, { query: 'osprey' });
  assert.deepEqual(eu.queries, [], 'the query never reached the removed region');
  assert.deepEqual(result.collections.map(entry => [entry.collectionId, entry.vector, entry.vectorError]),
    [['alpha', 'used', null], ['beta', 'unavailable', 'POLICY_CHANGED']]);
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.state, 'degraded');
  assert.ok(ids(result).includes(`alpha/record/${alpha}`));
  assert.ok(result.results.filter(hit => hit.ref.collectionId === 'beta').every(hit => hit.provenance.vectorRank === null),
    'beta answers lexically only');
});

test('access lapsing during one embedding call fails the search before the next group\'s query leaves', async () => {
  for (const table of ['collection_grants', 'space_credentials']) {
    const f = await fixture({ policy: { beta: { regions: ['eu'] } } });
    const local = new Spy();
    const eu = new Spy({}, 'eu');
    const both = new EmbeddingRegistry([local, eu]);
    await f.record('alpha', { title: 'osprey dive' });
    await f.record('beta', { title: 'osprey perch' });
    await index(both);
    const key = await f.agent([['alpha', ['records:read']], ['beta', ['records:read']]]);
    eu.queries.length = 0;
    local.behavior.before = async () => {
      local.behavior.before = undefined;
      await pool.query(`UPDATE ${table} SET expires_at=clock_timestamp() WHERE space_id=$1 AND credential_id=$2`,
        [f.spaceId, key.credentialId]);
    };
    await rejects(search(both).search(key, f.spaceId, { query: 'osprey' }), 'FORBIDDEN');
    assert.deepEqual(eu.queries, [], `${table}: the query never reached the next group's embedder`);
  }
});

/** Retire `collectionId`'s active generation 1 and activate an empty generation 2 under the same policy. */
async function cutover(client, spaceId, collectionId, vector = true) {
  await client.query(`INSERT INTO projection_generations(space_id,collection_id,generation,policy_version,embedder,embedding_model,
    model_version,dimensions) VALUES($1,$2,2,1,$3,$4,$5,$6)`,
  [spaceId, collectionId, ...(vector ? ['local-hash', 'feature-hash', '1', 384] : [null, null, null, null])]);
  await client.query(`UPDATE projection_generations SET state='verifying' WHERE space_id=$1 AND collection_id=$2 AND generation=2`,
    [spaceId, collectionId]);
  await client.query('BEGIN');
  await client.query(`UPDATE projection_generations SET state='retired' WHERE space_id=$1 AND collection_id=$2 AND generation=1`,
    [spaceId, collectionId]);
  await client.query(`UPDATE projection_generations SET state='active' WHERE space_id=$1 AND collection_id=$2 AND generation=2`,
    [spaceId, collectionId]);
  await client.query('COMMIT');
}

test('hits from a generation retired before the reread are stale; a cutover during it waits for the search', async () => {
  const f = await fixture({ collections: ['alpha'] });
  await f.record('alpha', { title: 'cormorant colony' });
  await index();
  // Cut over after the candidates were read: every candidate is from the retired generation.
  hooks = [{ match: LOCK_SPACE, run: async () => {
    const client = await pool.connect();
    try { await cutover(client, f.spaceId, 'alpha'); } finally { client.release(); }
  } }];
  const retired = await search(registry, hooked).search(f.owner, f.spaceId, { query: 'cormorant' });
  assert.equal(hooks.length, 0);
  assert.equal(retired.candidates.lexical, 1, 'read from generation 1 before the cutover');
  assert.deepEqual(retired.results, [], 'nothing from a retired generation is returned as current');
  assert.equal(retired.rejected.stale, 1);
  assert.ok(retired.underfill.reasons.includes('rejected'));

  // A cutover started while the reread holds the active generation waits for the search to commit.
  const g = await fixture({ collections: ['alpha'] });
  const held = await g.record('alpha', { title: 'cormorant roost' });
  await index();
  const order = [];
  let moving;
  hooks = [{ match: REREAD, run: async () => {
    const client = await pool.connect();
    moving = cutover(client, g.spaceId, 'alpha').then(() => order.push('cut over')).finally(() => client.release());
    for (let tries = 0; ; tries++) {
      const waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock'`)).rows[0].n;
      if (waiting) break;
      assert.ok(tries < 400, 'the cutover waits on the search');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } }];
  const kept = await search(registry, hooked).search(g.owner, g.spaceId, { query: 'cormorant' });
  order.push('searched');
  await moving;
  assert.deepEqual(ids(kept), [`alpha/record/${held}`]);
  assert.deepEqual(order, ['searched', 'cut over']);
});

test('the reread reads only the cited ranges of large texts, and a canonical-JSON record on demand', async () => {
  const f = await fixture({ collections: ['alpha'] });
  const filler = 'é'.repeat(200_000);
  const sourceId = await f.source('alpha', `The pelican ledger opens here. ${filler}`);
  const nul = await f.record('alpha', { title: 'pelican\u0000 wharf' });
  await index();
  const rows = [];
  const watched = { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, property) {
      if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
      return async (sql, ...rest) => {
        const reply = await target.query(sql, ...rest);
        if (typeof sql === 'string' && sql.includes(REREAD)) rows.push(...reply.rows);
        return reply;
      };
    } });
  } };
  const result = await search(registry, watched).search(f.owner, f.spaceId, { query: 'pelican' });
  assert.ok(rows.length >= 2);
  // No reread row carries more than one chunk's range of text.
  for (const row of rows) {
    assert.ok(!Object.hasOwn(row, 'whole'));
    assert.ok(row.text === null || [...row.text].length <= 1_000, 'only a cited range leaves the database');
  }
  const source = result.results.find(hit => hit.ref.id === sourceId);
  assert.ok(source.citations.length >= 1);
  const full = `The pelican ledger opens here. ${filler}`;
  for (const citation of source.citations) assert.equal(citation.text, [...full].slice(citation.start, citation.end).join(''));
  // A record jsonb cannot hold is cited from its canonical JSON, with its U+0000 intact.
  const record = result.results.find(hit => hit.ref.id === nul);
  assert.equal(record.citations[0].text, [...'pelican\u0000 wharf'].slice(record.citations[0].start, record.citations[0].end).join(''));
  assert.ok(record.citations[0].text.includes('\u0000'));
});

test('the cell role answers by vector with only its base grants and db:grant-retrieval', async () => {
  const f = await fixture({ policy: { beta: { lexical: false } } });
  const hybrid = await f.record('alpha', { title: 'curlew call' });
  const vectorOnly = await f.record('beta', { title: 'curlew wading' });
  await index();
  const retrievalTables = ['retrieval_policies', 'retrieval_collection_heads', 'vector_index_strategies', 'projection_generations',
    'projection_refs', 'projection_deletion_receipts', 'lexical_chunks', 'vector_chunks', 'embedding_checkpoints', 'retrieval_outbox',
    'retrieval_dispatch_checkpoint'];
  const role = `sta46_cell_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  const cellPool = new pg.Pool({ connectionString: target.toString(), max: 2, options: `-c role=${role}` });
  // Routines PUBLIC may execute now, so exactly those are granted back afterwards.
  const publicRoutines = (await pool.query(`SELECT p.oid::regprocedure::text AS routine FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))`)).rows.map(row => row.routine);
  try {
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`REVOKE ALL ON ${retrievalTables.join(',')} FROM ${role}`);
    await pool.query('REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC');
    execFileSync(process.execPath, ['scripts/grant-retrieval.mjs'], { cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: 'pipe', env: { ...process.env, STATEPLANE_CELL_ADMIN_URL: target.toString(), STATEPLANE_CELL_ROLE: role } });
    const result = await search(registry, cellPool).search(f.owner, f.spaceId, { query: 'curlew' });
    assert.deepEqual(result.collections.map(entry => [entry.collectionId, entry.vector, entry.vectorError]),
      [['alpha', 'used', null], ['beta', 'used', null]]);
    assert.equal(result.mode, 'hybrid');
    for (const id of [hybrid, vectorOnly]) {
      const hit = result.results.find(entry => entry.ref.id === id);
      assert.ok(hit?.provenance.vectorRank >= 1, `${id} found by vector`);
    }
  } finally {
    await cellPool.end();
    for (const routine of publicRoutines) await pool.query(`GRANT EXECUTE ON ROUTINE ${routine} TO PUBLIC`);
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
});

test('the lexical query uses the pg_catalog configuration that built the tsvector, whatever the search_path', async () => {
  const f = await fixture({ collections: ['alpha'], policy: { alpha: { vector: false } } });
  const id = await f.record('alpha', { title: 'Herons wading at dawn' });
  await index();
  // A same-named configuration earlier in the search_path that does not stem: `wading` would no longer find `wade`.
  const schema = `sta46_shadow_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TEXT SEARCH CONFIGURATION ${schema}.english (COPY = pg_catalog.simple)`);
  const shadowed = new pg.Pool({ connectionString: target.toString(), max: 2, options: `-c search_path=${schema},pg_catalog,public` });
  try {
    assert.equal((await shadowed.query(`SELECT 'english'::regconfig::oid=$1::regconfig::oid AS shadowed`, [`${schema}.english`]))
      .rows[0].shadowed, true, 'an unqualified name resolves to the shadowing configuration');
    const result = await search(registry, shadowed).search(f.owner, f.spaceId, { query: 'wading' });
    assert.deepEqual(ids(result), [`alpha/record/${id}`]);
    assert.equal(result.candidates.lexical, 1);
  } finally {
    await shadowed.end();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});

/**
 * A searcher whose final provider check waits until `collectionId`'s grant (set to lapse 1 s after the scope locks start)
 * lapsed; provider checks before then (before an embedding call) pass through.
 */
function lapsingDuringProviderCheck(f, key, collectionId) {
  const state = { armed: false, reached: false };
  const slow = new Proxy(spaces, { get(target, property) {
    if (property === 'assertCurrentUntil') return async (...args) => {
      if (!state.armed) return target.assertCurrentUntil(...args);
      state.reached = true;
      for (let tries = 0; ; tries++) {
        const { lapsed } = (await pool.query(`SELECT expires_at<=clock_timestamp() AS lapsed FROM collection_grants
          WHERE space_id=$1 AND credential_id=$2 AND collection_id=$3`, [f.spaceId, key.credentialId, collectionId])).rows[0];
        if (lapsed) break;
        assert.ok(tries < 400, 'the grant lapses');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return target.assertCurrentUntil(...args);
    };
    return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
  } });
  hooks = [{ match: LOCK_SPACE, run: async () => {
    state.armed = true;
    await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()+interval '1 second'
      WHERE space_id=$1 AND credential_id=$2 AND collection_id=$3`, [f.spaceId, key.credentialId, collectionId]);
  } }];
  return { searcher: new PostgresRetrievalSearch(slow, new Map([['cell-a', { pool: hooked }]]), { embedders: registry }), state };
}

test('the final check covers every grant behind the response: out-of-page, empty-result and claim-evidence grants', async () => {
  // Two collections match, the page holds alpha's hit only; beta's grant still backs the counts and beta's status.
  const f = await fixture({ policy: { alpha: { vector: false }, beta: { vector: false } } });
  await f.record('alpha', { title: 'puffin burrow puffin' });
  await f.record('beta', { title: 'puffin' });
  await index();
  const key = await f.agent([['alpha', ['records:read']], ['beta', ['records:read']]]);
  const page = await search().search(key, f.spaceId, { query: 'puffin', limit: 1 });
  assert.equal(page.results[0].ref.collectionId, 'alpha', 'alpha is the page');
  assert.equal(page.candidates.considered, 2);
  const outOfPage = lapsingDuringProviderCheck(f, key, 'beta');
  await rejects(outOfPage.searcher.search(key, f.spaceId, { query: 'puffin', limit: 1 }), 'FORBIDDEN');
  assert.ok(outOfPage.state.reached);

  // Nothing matches: the empty page and its collection status still depend on the searched collection's grant.
  const g = await fixture({ collections: ['alpha'], policy: { alpha: { vector: false } } });
  await g.record('alpha', { title: 'unrelated' });
  await index();
  const lone = await g.agent([['alpha', ['records:read']]]);
  const empty = lapsingDuringProviderCheck(g, lone, 'alpha');
  await rejects(empty.searcher.search(lone, g.spaceId, { query: 'guillemot' }), 'FORBIDDEN');
  assert.ok(empty.state.reached);

  // A claims search in alpha whose candidates and state used beta's sources:read only through the claim read rule.
  const h = await fixture({ policy: { alpha: { vector: false }, beta: { vector: false } } });
  const cited = await h.source('beta', 'A cliff count.');
  await claims.create(h.owner, h.spaceId, 'alpha', { idempotencyKey: randomUUID(), statement: 'Razorbills nest on the cliff.',
    attributedTo: 'count', evidence: [{ collectionId: 'beta', sourceId: cited }] });
  await index();
  const reader = await h.agent([['alpha', ['claims:read']], ['beta', ['sources:read']]]);
  const request = { query: 'guillemot', collections: ['alpha'] };
  assert.deepEqual((await search().search(reader, h.spaceId, request)).results, []);
  const evidence = lapsingDuringProviderCheck(h, reader, 'beta');
  await rejects(evidence.searcher.search(reader, h.spaceId, request), 'FORBIDDEN');
  assert.ok(evidence.state.reached);
});

test('a credential or grant expiring after the final check but before COMMIT fails the search', async () => {
  const final = 'sc.owner_principal_id=$3';
  for (const table of ['collection_grants', 'space_credentials']) {
    const f = await fixture({ collections: ['alpha'], policy: { alpha: { vector: false } } });
    await f.record('alpha', { title: 'shearwater raft' });
    await index();
    const key = await f.agent([['alpha', ['records:read']]]);
    const lapse = (after = '1 second') => pool.query(`UPDATE ${table} SET expires_at=clock_timestamp()+$3::interval
      WHERE space_id=$1 AND credential_id=$2`, [f.spaceId, key.credentialId, after]);
    let delayed = false;
    // Set to lapse before the scope locks (which would make the update wait), live for the final statement; then only the
    // reread's COMMIT is held until the expiry passed.
    hooks = [{ match: LOCK_SPACE, run: () => lapse() }, { match: final, run: async () => {
      hooks.push({ match: 'COMMIT', run: async () => {
        for (let tries = 0; ; tries++) {
          const { lapsed } = (await pool.query(`SELECT expires_at<=clock_timestamp() AS lapsed FROM ${table}
            WHERE space_id=$1 AND credential_id=$2`, [f.spaceId, key.credentialId])).rows[0];
          if (lapsed) break;
          assert.ok(tries < 400, 'the access lapses');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        delayed = true;
      } });
    } }];
    await rejects(search(registry, hooked).search(key, f.spaceId, { query: 'shearwater' }), 'FORBIDDEN');
    assert.ok(delayed, `${table}: COMMIT was delayed past the expiry`);
    // The same expiry with a prompt COMMIT still answers: no fixed margin is taken off the access.
    await lapse('1 hour');
    hooks = [{ match: LOCK_SPACE, run: () => lapse() }];
    assert.equal((await search(registry, hooked).search(key, f.spaceId, { query: 'shearwater' })).results.length, 1, table);
    assert.equal(hooks.length, 0);
  }
  // An owner session: its provider expiry bounds the search as a key's does.
  const g = await fixture({ collections: ['alpha'], policy: { alpha: { vector: false } } });
  await g.record('alpha', { title: 'shearwater raft' });
  await index();
  let expiresAt = null;
  const session = value => config.database.update({ model: 'sessions', where: [{ field: 'id', operator: 'eq',
    value: g.owner.credentialId }], data: { expiresAt: (expiresAt = value) }, namespace: config.namespace });
  hooks = [{ match: LOCK_SPACE, run: async () => {
    await session(new Date(Date.now() + 1_000));
    hooks.push({ match: 'COMMIT', run: async () => {
      while (Date.now() <= expiresAt.getTime() + 5) await new Promise(resolve => setTimeout(resolve, 5));
    } });
  } }];
  await rejects(search(registry, hooked).search(g.owner, g.spaceId, { query: 'shearwater' }), 'FORBIDDEN');
  assert.equal(hooks.length, 0, 'session: COMMIT was delayed past the expiry');
  for (const later of [new Date(Date.now() + 3_600_000), null]) {
    await session(later);
    assert.equal((await search().search(g.owner, g.spaceId, { query: 'shearwater' })).results.length, 1, `session expiring ${later}`);
  }
});

test('the cap witness grant is a dependency: its lapse before the reread or during the final check fails the search', async () => {
  const names = Array.from({ length: 33 }, (_, i) => `c${String(i).padStart(2, '0')}`);
  const f = await fixture({ collections: names, policy: Object.fromEntries(names.map(name => [name, { vector: false }])) });
  await f.record('c00', { title: 'kittiwake ledge' });
  await index();
  const key = await f.agent(names.map(name => [name, ['records:read']]));
  const control = await search().search(key, f.spaceId, { query: 'kittiwake' });
  assert.equal(control.collectionsCapped, true);
  assert.equal(control.collections.length, 32);
  assert.ok(control.underfill.reasons.includes('capped'));
  // c32, never searched, lapses during the final provider check of an empty page.
  const lapsing = lapsingDuringProviderCheck(f, key, 'c32');
  await rejects(lapsing.searcher.search(key, f.spaceId, { query: 'guillemot' }), 'FORBIDDEN');
  assert.ok(lapsing.state.reached);
  // Live again; then it lapses after the plan, before the reread's locks.
  await pool.query(`UPDATE collection_grants SET expires_at=NULL WHERE space_id=$1 AND credential_id=$2 AND collection_id='c32'`,
    [f.spaceId, key.credentialId]);
  hooks = [{ match: LOCK_SPACE, run: () => expire(f.spaceId, key, 'c32') }];
  await rejects(search(registry, hooked).search(key, f.spaceId, { query: 'kittiwake' }), 'FORBIDDEN');
  assert.equal(hooks.length, 0);
});

test('coverage is observed after the candidates: a cutover or a revision before the lexical read withholds exhausted', async () => {
  // A cutover between the plan and the lexical statement: the new generation was never searched.
  const f = await fixture({ collections: ['alpha'], policy: { alpha: { vector: false } } });
  await f.record('alpha', { title: 'unrelated' });
  await index();
  assert.deepEqual((await search().search(f.owner, f.spaceId, { query: 'skua' })).underfill.reasons, ['exhausted']);
  hooks = [{ match: 'websearch_to_tsquery', run: async () => {
    const client = await pool.connect();
    try { await cutover(client, f.spaceId, 'alpha', false); } finally { client.release(); }
  } }];
  const cut = await search(registry, hooked).search(f.owner, f.spaceId, { query: 'skua' });
  assert.equal(hooks.length, 0);
  assert.equal(cut.candidates.lexical, 0);
  assert.equal(cut.state, 'pending');
  assert.deepEqual(cut.collections.map(entry => entry.projection), ['pending']);
  assert.deepEqual(cut.underfill.reasons, ['pending']);

  // A matching record revised just before the lexical statement, its projection work not yet done.
  const g = await fixture({ collections: ['alpha'], policy: { alpha: { vector: false } } });
  const id = await g.record('alpha', { title: 'reviewnewmatch original' });
  await index();
  // Delivered after the lexical read, before the reread's refresh: only the candidate snapshot saw it waiting.
  hooks = [{ match: 'websearch_to_tsquery', run: () => g.record('alpha', { title: 'reviewnewmatch revised' },
    { recordId: id, expectedRevision: 1 }, 'replace') }, { match: LOCK_SPACE, run: () => index() }];
  const revised = await search(registry, hooked).search(g.owner, g.spaceId, { query: 'reviewnewmatch' });
  assert.equal(hooks.length, 0);
  assert.deepEqual(revised.results, []);
  assert.equal(revised.state, 'pending');
  assert.deepEqual(revised.underfill.reasons, ['pending']);
  assert.equal((await search().search(g.owner, g.spaceId, { query: 'reviewnewmatch' })).results.length, 1, 'current again');

  // Waiting when planned, delivered after the lexical read and before the refresh: a later current never overwrites it.
  const h = await fixture({ collections: ['alpha'], policy: { alpha: { vector: false } } });
  await h.record('alpha', { title: 'auklet colony' });
  hooks = [{ match: LOCK_SPACE, run: () => index() }];
  const waiting = await search(registry, hooked).search(h.owner, h.spaceId, { query: 'auklet' });
  assert.equal(hooks.length, 0);
  assert.deepEqual(waiting.results, []);
  assert.equal(waiting.state, 'pending');
  assert.deepEqual(waiting.underfill.reasons, ['pending']);
  assert.equal((await search().search(h.owner, h.spaceId, { query: 'auklet' })).results.length, 1, 'delivered');
});

test('a collection deleted after the plan contributes no candidates and crowds out no live match', async () => {
  const f = await fixture({ policy: { alpha: { vector: false }, beta: { vector: false } } });
  const live = await f.record('alpha', { title: 'gannet' });
  for (let i = 0; i < 20; i++) await f.record('beta', { title: `gannet gannet gannet ${i}`, note: 'gannet gannet' });
  await index();
  hooks = [{ match: 'websearch_to_tsquery', run: () => pool.query(`UPDATE collections SET lifecycle='deleted'
    WHERE space_id=$1 AND collection_id='beta'`, [f.spaceId]) }];
  const result = await search(registry, hooked).search(f.owner, f.spaceId, { query: 'gannet', limit: 1 });
  assert.equal(hooks.length, 0);
  assert.deepEqual(ids(result), [`alpha/record/${live}`]);
  assert.equal(result.candidates.lexical, 1, "beta's chunks are no candidates");
  assert.deepEqual(result.rejected, { deleted: 0, stale: 0, unauthorized: 0 });
});

test('an exact (unindexed dimension) vector list that comes back short is exhaustive, not approximate', async () => {
  const wide = new (class extends DeterministicEmbedder {})({ embedder: 'local-hash', dimensions: 3072 });
  const embedders = new EmbeddingRegistry([wide]);
  const f = await fixture({ collections: ['alpha'], policy: { alpha: { lexical: false, dimensions: 3072 } } });
  const id = await f.record('alpha', { title: 'fulmar glide' });
  await index(embedders);
  const result = await search(embedders).search(f.owner, f.spaceId, { query: 'fulmar' });
  assert.deepEqual(ids(result), [`alpha/record/${id}`]);
  assert.equal(result.collections[0].vector, 'used');
  assert.deepEqual(result.underfill.reasons, ['exhausted'], 'the 3072-dimension scan is exact');
});

test('stalled embedders in several groups share one vector budget before the lexical fallback', async () => {
  const regions = ['r1', 'r2', 'r3'];
  const f = await fixture({ collections: ['alpha', ...regions], policy: { alpha: { vector: false },
    ...Object.fromEntries(regions.map(region => [region, { regions: [region] }])) } });
  const id = await f.record('alpha', { title: 'petrel' });
  await index();
  const embedders = new EmbeddingRegistry(regions.map(region => new Spy({ hang: true }, region)));
  const started = Date.now();
  const result = await search(embedders).search(f.owner, f.spaceId, { query: 'petrel' });
  assert.ok(Date.now() - started < 3_500, `three stalled groups took ${Date.now() - started} ms, not one 2 s budget`);
  assert.deepEqual(ids(result), [`alpha/record/${id}`]);
  assert.deepEqual(result.collections.map(entry => [entry.collectionId, entry.vector, entry.vectorError]),
    [['alpha', 'disabled', null], ...regions.map(region => [region, 'unavailable', 'EMBEDDER_UNAVAILABLE'])]);
  // The budget running out during a group's admission read is the same outage, not a failed vector query, and the search
  // answers while that read is still held.
  let release;
  hooks = [{ match: ADMISSION, run: () => new Promise(resolve => { release = resolve; }) }];
  try {
    const late = await Promise.race([
      search(embedders, hooked).search(f.owner, f.spaceId, { query: 'petrel', collections: ['alpha', 'r1'] }),
      sleep(3_500).then(() => assert.fail('the search waited for its admission read'))]);
    assert.equal(hooks.length, 0);
    assert.deepEqual(late.collections.map(entry => [entry.collectionId, entry.vector, entry.vectorError]),
      [['alpha', 'disabled', null], ['r1', 'unavailable', 'EMBEDDER_UNAVAILABLE']]);
    assert.deepEqual(ids(late), [`alpha/record/${id}`]);
  } finally { release?.(); }
});

test('access expiring during admission stops the query before it leaves: grant, regional key, session and wall clock', async () => {
  for (const what of ['collection_grants', 'space_credentials', 'session', 'wall clock']) {
    const f = await fixture({ collections: ['alpha'] });
    await f.record('alpha', { title: 'osprey dive' });
    await index();
    const key = what.includes('_') ? await f.agent([['alpha', ['records:read']]]) : null;
    const spy = new Spy();
    const now = Date.now;
    const findOne = config.database.findOne;
    // Current at the admission check, lapsed once the admission transaction has committed, so the embedder call must
    // not start. Each lapse is written only after the check's own read has seen access current, however long that read
    // took: a key's or grant's once the remaining_ms statement has answered (which then reports no more time left than
    // the expiry written), a session's once the provider's session read has returned (the provider compares its expiry
    // in-process next). The ADMISSION read, reached only once that check has passed, then waits for the lapse itself.
    // The wall-clock case gives the session a long expiry and steps the clock past it instead.
    let lapsed = null;
    let sessionRead = false;
    const arm = { collection_grants: () => hooks.unshift({ match: 'AS remaining_ms', after: async read => {
      const seen = read.rows[0];
      assert.ok(seen?.current === true && Number(seen.remaining_ms) > 0, `${what}: the admission check read access current`);
      const written = (await pool.query(`UPDATE ${what} SET expires_at=clock_timestamp()+interval '300 milliseconds'
        WHERE space_id=$1 AND credential_id=$2 RETURNING EXTRACT(EPOCH FROM expires_at-clock_timestamp())*1000 AS remaining_ms`,
      [f.spaceId, key.credentialId])).rows.map(row => Number(row.remaining_ms));
      assert.ok(written.length, `${what}: the expiry was written`);
      lapsed = async () => (await pool.query(`SELECT bool_and(expires_at<=clock_timestamp()) AS lapsed FROM ${what}
        WHERE space_id=$1 AND credential_id=$2`, [f.spaceId, key.credentialId])).rows[0].lapsed;
      return { ...read, rows: [{ ...seen, remaining_ms: Math.min(Number(seen.remaining_ms), ...written) }] };
    } }), session: () => { sessionRead = true; }, 'wall clock': () => sessionExpiry(f.owner, new Date(Date.now() + 60_000)) };
    arm.space_credentials = arm.collection_grants;
    config.database.findOne = async function (query, ...rest) {
      const record = await findOne.call(this, query, ...rest);
      if (!sessionRead || query.model !== 'sessions' || !record) return record;
      sessionRead = false;
      const until = Date.now() + 300;
      const written = sessionExpiry(f.owner, new Date(until));
      lapsed = async () => { await written; return Date.now() > until; };
      return { ...record, expiresAt: new Date(until) };
    };
    hooks = [{ match: PLAN, run: async () => { await arm[what](); } }, { match: ADMISSION, run: async () => {
      if (what === 'wall clock') { Date.now = () => now() + 120_000; return; }
      assert.ok(lapsed, `${what}: the lapse was armed by the admission credential check`);
      // Bounded well inside the 2 s vector budget, so the outcome is FORBIDDEN, never EMBEDDER_UNAVAILABLE.
      const give = performance.now() + 1_000;
      while (!(await lapsed())) {
        assert.ok(performance.now() < give, `${what}: access lapsed during admission`);
        await sleep(10);
      }
    } }];
    try { await rejects(search(new EmbeddingRegistry([spy]), hooked).search(key ?? f.owner, f.spaceId, { query: 'osprey' }), 'FORBIDDEN'); }
    finally { Date.now = now; config.database.findOne = findOne; }
    assert.equal(hooks.length, 0, `${what}: the admission check saw access current`);
    assert.deepEqual(spy.queries, [], `${what}: the query never reached the embedder`);
  }
});

test("a wall-clock step past the provider's expiry before the reread COMMIT fails the search", async () => {
  const g = await fixture({ collections: ['alpha'], policy: { alpha: { vector: false } } });
  await g.record('alpha', { title: 'shearwater raft' });
  await index();
  const now = Date.now;
  hooks = [{ match: LOCK_SPACE, run: async () => {
    await sessionExpiry(g.owner, new Date(Date.now() + 2_000));
    hooks.push({ match: 'COMMIT', run: async () => { Date.now = () => now() + 5_000; } });
  } }];
  try { await rejects(search(registry, hooked).search(g.owner, g.spaceId, { query: 'shearwater' }), 'FORBIDDEN'); }
  finally { Date.now = now; }
  assert.equal(hooks.length, 0, 'the clock stepped just before COMMIT');
  // The same expiry without the step still answers.
  hooks = [{ match: LOCK_SPACE, run: () => sessionExpiry(g.owner, new Date(Date.now() + 2_000)) }];
  assert.equal((await search(registry, hooked).search(g.owner, g.spaceId, { query: 'shearwater' })).results.length, 1);
  assert.equal(hooks.length, 0);
});

test('an admission stalled past the vector budget frees its connection: lexical answers on a one-connection pool', async () => {
  const f = await fixture({ collections: ['alpha'] });
  const id = await f.record('alpha', { title: 'petrel' });
  await index();
  const single = new pg.Pool({ connectionString: target.toString(), max: 1 });
  const currentUntil = identity.currentUntil;
  try {
    for (const stalled of ['admission read', 'provider']) {
      const spy = new Spy();
      let armed = false;
      identity.currentUntil = async function (...args) {
        if (armed) { armed = false; await sleep(4_000); }
        return currentUntil.apply(this, args);
      };
      hooks = stalled === 'provider' ? [{ match: PLAN, run: async () => { armed = true; } }]
        : [{ match: ADMISSION, run: () => sleep(4_000) }];
      const started = performance.now();
      const result = await search(new EmbeddingRegistry([spy]), hookedOn(single)).search(f.owner, f.spaceId, { query: 'petrel' });
      const took = performance.now() - started;
      assert.ok(took < 3_000, `${stalled}: lexical answered after ${Math.round(took)} ms, not within the 2 s budget`);
      assert.deepEqual(ids(result), [`alpha/record/${id}`]);
      assert.deepEqual(result.collections.map(entry => [entry.vector, entry.vectorError]), [['unavailable', 'EMBEDDER_UNAVAILABLE']]);
      assert.equal(hooks.length, 0, stalled);
      // Once the stall has passed, the late admission still sends nothing, and the pool's one connection serves the next search.
      await sleep(2_500);
      assert.deepEqual(spy.queries, [], `${stalled}: the late admission never embedded`);
      identity.currentUntil = currentUntil;
      const next = await search(registry, single).search(f.owner, f.spaceId, { query: 'petrel' });
      assert.equal(next.mode, 'hybrid', stalled);
      assert.deepEqual(ids(next), [`alpha/record/${id}`]);
    }
  } finally { identity.currentUntil = currentUntil; await single.end(); }
});
