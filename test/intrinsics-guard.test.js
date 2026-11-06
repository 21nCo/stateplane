import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// STA-58: the aggregation module, and every helper an aggregation or a record read reaches in the predicate compiler,
// request snapshot, scalar checks and transaction lifecycle, calls built-ins only through the load-time captures in
// packages/postgres/src/intrinsics.ts (or captures of its own made at load), never a live global or inherited method.
const source = file => readFileSync(new URL(`../packages/postgres/src/${file}`, import.meta.url), 'utf8');
const FORBIDDEN = [/\bReflect\.\w/, /\bObject\.\w/, /\bArray\.(?:isArray|from|of)\b/, /\b(?:Number|JSON|Math|Buffer|Intl|performance)\.\w/,
  /\bDate\.now\b/, /\b(?:Array|String|RegExp|Map|Set|WeakMap|Date)\.prototype\b/, /\bnew (?:Map|Set|WeakMap|Date)\b/,
  /\b(?:Number|String|BigInt)\(/,
  /\.(?:push|pop|map|filter|forEach|some|every|reduce|includes|indexOf|join|slice|splice|concat|find|sort|replace|split|startsWith|endsWith|padStart|toLowerCase|trim|test|exec|toISOString|getTime|clear)\(/];
// Comments and type assertions (`as Intl.DateTimeFormatOptions`) are not calls.
const stripped = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1').replace(/\bas [\w.]+/g, '');

/** The text of a top-level function or const, or a class method, from its first line until its braces close. */
function region(text, name) {
  const lines = text.split('\n');
  const find = pattern => lines.findIndex(line => new RegExp(pattern).test(line));
  let start = find(`^(?:export )?(?:async )?function ${name}\\b|^(?:export )?const ${name}\\s*=`);
  if (start < 0) start = find(`^  (?:private |async )*${name}\\(.*\\{`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0, opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (char === '{') { depth++; opened = true; } else if (char === '}') depth--;
    }
    if ((opened && depth === 0) || (!opened && /;\s*$/.test(lines[i]))) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`${name} does not close`);
}
const violations = (label, text) => {
  const found = [];
  for (const line of stripped(text).split('\n')) for (const pattern of FORBIDDEN) if (pattern.test(line)) found.push(`${label}: ${line.trim()}`);
  return found;
};
export const COVERED = {
  'index.ts': ['comparison', 'predicateColumn', 'sqlOperator', 'validPredicateValue', 'valueString', 'scalarString', 'predicateFilter',
    'snapshotPredicates', 'parseSerializedPredicates', 'predicateDataKeys', 'snapshotInValues', 'snapshotPredicate', 'arrayHas',
    'validScope', 'mapValues', 'setValues', 'close', 'compilePredicates'],
  'schema.ts': ['includes', 'distinct', 'any', 'scalarLength', 'scalarString', 'utcInstant'],
  'sources.ts': ['serialized', 'fields', 'within', 'transact']
};
/** Every violation in the covered sources, or in `override` text standing in for one file. */
export function guardViolations(override = {}) {
  const text = file => override[file] ?? source(file);
  // The whole aggregation module, apart from its load-time captures of prototype methods and timers.
  const module = text('aggregations.ts').split('\n').filter(line => !/^const native\w+ = /.test(line)).join('\n');
  const found = violations('aggregations.ts', module);
  for (const [file, names] of Object.entries(COVERED)) for (const name of names) found.push(...violations(`${file} ${name}`, region(text(file), name)));
  return found;
}

test('aggregation and shared predicate paths call built-ins only through load-time captures', () => {
  assert.deepEqual(guardViolations(), []);
});

test('the guard fails when a covered path calls a live built-in again', () => {
  const index = source('index.ts'), aggregations = source('aggregations.ts'), sources = source('sources.ts');
  const reintroduced = [
    ['index.ts', index.replace('mapClear(this.reservedIdentities);', 'Reflect.apply(Map.prototype.clear, this.reservedIdentities, []);')],
    ['index.ts', index.replace('append(params,predicate.value);', 'params.push(predicate.value);')],
    ['aggregations.ts', aggregations.replace('const length = ownDescriptor(value, \'length\')!.value as number;',
      'const length = Object.getOwnPropertyDescriptor(value, \'length\')!.value as number;')],
    ['sources.ts', sources.replace('const end = until === undefined ? undefined : min(until, monotonicNow() + CLEANUP_CALL_MS);',
      'const end = until === undefined ? undefined : Math.min(until, performance.now() + CLEANUP_CALL_MS);')]];
  for (const [file, text] of reintroduced) {
    assert.notEqual(text, source(file), `${file} mutation applies`);
    assert.ok(guardViolations({ [file]: text }).length > 0, `${file} mutation is caught`);
  }
});
