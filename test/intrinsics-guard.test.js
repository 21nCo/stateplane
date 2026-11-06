import test from 'node:test';
import assert from 'node:assert/strict';
import { COVERED, documentedCovered, guardViolations, sourceText } from './covered-paths.js';
import { transact } from '../packages/postgres/dist/sources.js';
import { commitBeforeDeadline, CommitNotSentDeadlineExceeded } from '../packages/postgres/dist/commit-deadline.js';

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
    ['sources.ts', sources.replace('try { return await race([pending, timeout]); }', 'try { return await Promise.race([pending, timeout]); }')],
    ['sources.ts', sources.replace('return await fn(client);', 'return fn(client);')],
    ['sources.ts', sources.replace('return await fn(client);', 'return (fn(client));')]];
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

test('COMMIT is reported unsent only before it is handed to the client', async () => {
  let sent = 0;
  const mark = () => { sent++; };
  const client = query => ({ query });
  // Before the hand-off: the clock fails, or the deadline has passed.
  await assert.rejects(commitBeforeDeadline(client(() => Promise.resolve()), Infinity, mark, () => { throw new Error('clock'); }), /clock/);
  await assert.rejects(commitBeforeDeadline(client(() => Promise.resolve()), 0, mark), error => error instanceof CommitNotSentDeadlineExceeded);
  assert.equal(sent, 0);
  // From the hand-off on, even a synchronous failure may have reached the session.
  await assert.rejects(commitBeforeDeadline(client(() => { throw new Error('sync'); }), Infinity, mark), /sync/);
  assert.equal(sent, 1);
});

test('transact reports a COMMIT that failed in the client as of unknown outcome, and adopts foreign thenables', async () => {
  const thenable = value => ({ then: (fulfilled, rejected) => Promise.resolve(value).then(fulfilled, rejected) });
  const session = (commit, wrap = value => Promise.resolve(value)) => ({ query: sql => sql === 'COMMIT' ? commit() : wrap({ rows: [] }),
    release() {}, on() {}, removeListener() {} });
  const unknown = error => error.name === 'CommitOutcomeUnknownError' || /Commit outcome unknown/.test(error.message);
  let forwarded = 0;
  // A synchronous failure before or after a wrapper forwards COMMIT: either may have reached the session.
  await assert.rejects(transact({ connect: async () => session(() => { throw new Error('before forwarding'); }) }, async () => 1), unknown);
  await assert.rejects(transact({ connect: async () => session(() => { forwarded++; throw new Error('after forwarding'); }) }, async () => 1),
    unknown);
  assert.equal(forwarded, 1);
  await assert.rejects(transact({ connect: async () => session(() => Promise.reject(new Error('lost after send'))) }, async () => 1), unknown);
  // A driver with its own promise library: every statement, COMMIT included, answers with a thenable that is not a native promise.
  assert.equal(await transact({ connect: () => thenable(session(() => thenable({ rows: [] }), thenable)) }, async () => 1), 1);
  assert.equal(await transact({ connect: async () => session(() => Promise.resolve({ rows: [] })) }, async () => 1), 1);
});
