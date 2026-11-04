import test from 'node:test';
import assert from 'node:assert/strict';
import { ndcgAt, percentile, precisionAt, recallAt, reciprocalRank } from '../scripts/relevance-metrics.mjs';
import { relevanceCollections, relevanceDocuments, relevanceQueries } from './fixtures/relevance-corpus.js';

test('ranking metrics match hand-computed values', () => {
  const relevant = { a: 2, b: 1 };
  assert.equal(ndcgAt(10, ['a', 'b'], relevant), 1, 'the ideal order');
  // DCG of [x, a, b] = 3/log2(3) + 1/log2(4); ideal = 3/1 + 1/log2(3).
  const expected = (3 / Math.log2(3) + 1 / 2) / (3 + 1 / Math.log2(3));
  assert.ok(Math.abs(ndcgAt(10, ['x', 'a', 'b'], relevant) - expected) < 1e-12);
  assert.equal(ndcgAt(1, ['b', 'a'], relevant), 1 / 3, 'only the first position counts at k = 1');
  assert.equal(ndcgAt(10, ['a'], {}), 0, 'no relevant document scores 0, not NaN');
  assert.equal(recallAt(1, ['a', 'b'], relevant), 0.5);
  assert.equal(recallAt(10, ['x'], relevant), 0);
  assert.equal(precisionAt(5, ['a', 'x'], relevant), 0.2, 'empty positions of a short list count as misses');
  assert.equal(reciprocalRank(['x', 'y', 'b'], relevant), 1 / 3);
  assert.equal(reciprocalRank(['x'], relevant), 0);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile([], 50), null);
});

test('the relevance corpus judges only documents it holds, inside each query filter', () => {
  const byId = new Map(relevanceDocuments.map(document => [document.id, document]));
  assert.equal(byId.size, relevanceDocuments.length, 'document IDs are distinct');
  assert.equal(new Set(relevanceQueries.map(query => query.id)).size, relevanceQueries.length, 'query IDs are distinct');
  for (const document of relevanceDocuments) {
    assert.ok(relevanceCollections.includes(document.collection), document.id);
    assert.ok(['record', 'source', 'claim'].includes(document.kind), document.id);
  }
  for (const query of relevanceQueries) {
    assert.ok(['keyword', 'morphology', 'paraphrase', 'filtered'].includes(query.class), query.id);
    assert.equal(query.class === 'filtered', query.filter !== undefined, query.id);
    assert.ok(Object.keys(query.relevant).length, query.id);
    for (const [id, grade] of Object.entries(query.relevant)) {
      const document = byId.get(id);
      assert.ok(document && [1, 2].includes(grade), `${query.id} judges ${id}`);
      assert.ok(!query.filter?.collections || query.filter.collections.includes(document.collection), `${query.id}: ${id} in filter`);
      assert.ok(!query.filter?.kinds || query.filter.kinds.includes(document.kind), `${query.id}: ${id} in filter`);
    }
    // A paraphrase shares no content word with what it is about, so it needs a semantic embedder.
    if (query.class === 'paraphrase') {
      // Words compared by their first five letters, a crude stem (flower and flowers, night and nightly).
      const stop = new Set(['the', 'and', 'for', 'from', 'into', 'that', 'with', 'its', 'are', 'was', 'how', 'has', 'had', 'their']);
      const stems = text => new Set(text.toLowerCase().match(/[a-z]{3,}/g).filter(word => !stop.has(word)).map(word => word.slice(0, 5)));
      const asked = stems(query.query);
      for (const id of Object.keys(query.relevant))
        assert.deepEqual([...stems(byId.get(id).text)].filter(stem => asked.has(stem)), [], `${query.id} shares no word with ${id}`);
    }
  }
});
