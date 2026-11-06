import test from 'node:test';
import assert from 'node:assert/strict';
import { COVERED, documentedCovered, guardViolations, sourceText } from './covered-paths.js';
import { transact } from '../packages/postgres/dist/sources.js';

// STA-58: every path in COVERED (test/covered-paths.js) calls built-ins only through load-time captures, never a live
// global or inherited method, and docs/analysis-aggregations.md states exactly that list.

test('aggregation and shared predicate paths call built-ins only through load-time captures', () => {
  assert.deepEqual(guardViolations(), []);
});

test('the guard fails when a covered path calls a live built-in again, in any syntax', () => {
  const index = sourceText('index.ts'), aggregations = sourceText('aggregations.ts'), sources = sourceText('sources.ts');
  const commit = sourceText('commit-deadline.ts');
  const clock = 'const remaining=deadline-now();';
  const reintroduced = [
    ['index.ts', index.replace('mapClear(this.reservedIdentities);', 'Reflect.apply(Map.prototype.clear, this.reservedIdentities, []);')],
    ['index.ts', index.replace('append(params,predicate.value);', 'params.push(predicate.value);')],
    ['aggregations.ts', aggregations.replace('const length = ownDescriptor(value, \'length\')!.value as number;',
      'const length = Object.getOwnPropertyDescriptor(value, \'length\')!.value as number;')],
    ['sources.ts', sources.replace('const end = until === undefined ? undefined : min(until, monotonicNow() + CLEANUP_CALL_MS);',
      'const end = until === undefined ? undefined : Math.min(until, performance.now() + CLEANUP_CALL_MS);')],
    ['commit-deadline.ts', commit.replace(clock, 'const remaining=deadline-Date.now();')],
    ['commit-deadline.ts', commit.replace(clock, `${clock} const x: unknown[] = []; x['push'](remaining);`)],
    ['commit-deadline.ts', commit.replace(clock, `${clock} const x: unknown[] = []; x.push (remaining);`)],
    ['commit-deadline.ts', commit.replace(clock, `${clock} const x: unknown[] = []; x.push\n  (remaining);`)],
    ['commit-deadline.ts', commit.replace(clock, 'const remaining=deadline-globalThis.Date.now();')],
    ['commit-deadline.ts', commit.replace(clock, 'const remaining=deadline-Date [\'now\']();')],
    ['commit-deadline.ts', commit.replace(clock, `${clock} void new Promise(resolve => resolve(remaining));`)],
    ['commit-deadline.ts', commit.replace('settle(committed,undefined,()=>{});', 'void committed\n      .catch(()=>{});')],
    ['sources.ts', sources.replace('try { return await race([pending, timeout]); }', 'try { return await Promise.race([pending, timeout]); }')]];
  for (let i = 0; i < reintroduced.length; i++) {
    const [file, text] = reintroduced[i];
    assert.notEqual(text, sourceText(file), `${file} mutation ${i} applies`);
    assert.ok(guardViolations({ [file]: text }).length > 0, `${file} mutation ${i} is caught`);
  }
});

test('the documented covered paths are exactly the guarded list', () => {
  assert.deepEqual(documentedCovered(), COVERED);
  const documented = documentedCovered();
  documented['index.ts'] = documented['index.ts'].slice(1);
  assert.notDeepEqual(documented, COVERED, 'an entry missing from the docs fails');
  assert.notDeepEqual(documentedCovered(), { ...COVERED, 'schema.ts': COVERED['schema.ts'].slice(1) }, 'an entry missing from the list fails');
});

test('a COMMIT that never reached the session is retryable, never an unknown outcome', async () => {
  const session = commit => ({ query: sql => sql === 'COMMIT' ? commit() : Promise.resolve({ rows: [] }),
    release() {}, on() {}, removeListener() {} });
  // Refused before dispatch: the driver throws instead of sending.
  await assert.rejects(transact({ connect: async () => session(() => { throw new Error('not sent'); }) }, async () => 1), error => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, true);
    return true;
  });
  // Sent, then the session failed: the outcome is unknown.
  await assert.rejects(transact({ connect: async () => session(() => Promise.reject(new Error('lost after send'))) }, async () => 1),
    error => error.name === 'CommitOutcomeUnknownError' || /Commit outcome unknown/.test(error.message));
  assert.equal(await transact({ connect: async () => session(() => Promise.resolve({ rows: [] })) }, async () => 1), 1);
});
