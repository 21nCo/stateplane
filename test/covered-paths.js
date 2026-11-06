import { readFileSync } from 'node:fs';
import ts from 'typescript';

// STA-58: the paths that call built-ins only through the load-time captures in packages/postgres/src/intrinsics.ts (or a
// module's own load-time `const native… =` captures), never a live global or inherited method. `*` is a whole module;
// `Class.method` is one method. docs/analysis-aggregations.md reproduces this list, and test/intrinsics-guard.test.js
// checks that it does and that no listed path calls a live built-in.
export const COVERED = {
  'aggregations.ts': ['*'],
  'commit-deadline.ts': ['*'],
  'index.ts': ['comparison', 'predicateColumn', 'sqlOperator', 'validPredicateValue', 'valueString', 'scalarString', 'predicateFilter',
    'snapshotPredicates', 'parseSerializedPredicates', 'predicateDataKeys', 'snapshotInValues', 'snapshotPredicate', 'arrayHas',
    'validScope', 'mapValues', 'setValues', 'AuthorityTransaction.close', 'AuthorityTransaction.checkScope',
    'AuthorityTransaction.compilePredicates'],
  'schema.ts': ['includes', 'distinct', 'any', 'scalarLength', 'scalarString', 'utcInstant'],
  'sources.ts': ['serialized', 'fields', 'within', 'transact']
};

/** Globals a covered path never names: their statics, constructors and functions can all be replaced after load. */
const GLOBALS = new Set(['globalThis', 'Reflect', 'Object', 'Array', 'Number', 'String', 'Boolean', 'BigInt', 'Symbol', 'JSON',
  'Math', 'Buffer', 'Intl', 'performance', 'Date', 'Promise', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask']);
/** Inherited methods a covered path never calls, by dot or by computed name. */
const METHODS = new Set(['push', 'pop', 'map', 'filter', 'forEach', 'some', 'every', 'reduce', 'includes', 'indexOf', 'join', 'slice',
  'splice', 'concat', 'find', 'sort', 'replace', 'split', 'startsWith', 'endsWith', 'padStart', 'toLowerCase', 'trim', 'test', 'exec',
  'toISOString', 'getTime', 'clear', 'then', 'catch', 'finally', 'call', 'apply', 'bind']);

export const sourceText = (file, dir = 'src') => readFileSync(new URL(`../packages/postgres/${dir}/${file}`, import.meta.url), 'utf8');
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
  file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
const nameOf = node => node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) ? node.name.text : undefined;
const isCapture = statement => ts.isVariableStatement(statement) &&
  statement.declarationList.declarations.every(item => /^native/.test(nameOf(item) ?? ''));

/** The nodes `names` cover in `file`'s `text`, a source (.ts) or its build (.js); a name that matches nothing fails. */
export function coveredNodes(file, text, names = COVERED[file]) {
  const root = parse(file, text);
  if (names.includes('*')) return root.statements.filter(statement => !isCapture(statement) && !ts.isImportDeclaration(statement));
  const found = [];
  for (const name of names) {
    const [owner, member] = name.includes('.') ? name.split('.') : [undefined, name];
    const before = found.length;
    for (const statement of root.statements) {
      if (owner === undefined && ts.isFunctionDeclaration(statement) && nameOf(statement) === member) found.push(statement);
      if (owner === undefined && ts.isVariableStatement(statement))
        found.push(...statement.declarationList.declarations.filter(item => nameOf(item) === member));
      if (owner !== undefined && ts.isClassDeclaration(statement) && nameOf(statement) === owner)
        found.push(...statement.members.filter(item => nameOf(item) === member));
    }
    if (found.length === before) throw new Error(`${file} ${name} not found`);
  }
  return found;
}

/** 1-based [first, last] line ranges of the covered nodes, to place a stack frame of the build. */
export function coveredLines(file, text, names = COVERED[file]) {
  const root = parse(file, text);
  return coveredNodes(file, text, names).map(node => [root.getLineAndCharacterOfPosition(node.getStart(root)).line + 1,
    root.getLineAndCharacterOfPosition(node.getEnd()).line + 1]);
}

const skipParentheses = node => ts.isParenthesizedExpression(node) ? skipParentheses(node.expression) : node;
const enclosingFunction = node => { let at = node.parent; while (at && !ts.isFunctionLike(at)) at = at.parent; return at; };
const asyncFunction = node => node !== undefined && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) !== 0;
const literalName = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
/** Every live-global reference or inherited-method call in the nodes, whatever its spacing or property syntax. */
function violationsIn(label, root, nodes) {
  const found = [];
  const flag = node => found.push(`${label}: ${node.getText(root).replace(/\s+/g, ' ').slice(0, 120)}`);
  const visit = node => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isIdentifier(node) && GLOBALS.has(node.text)) {
      const parent = node.parent;
      const named = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node)
        || ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)
          || ts.isPropertyDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node);
      if (!named) flag(parent);
    }
    // An async function that returns a call's promise is resolved through a lookup of that promise's `then`.
    const returned = ts.isReturnStatement(node) ? node.expression
      : ts.isArrowFunction(node) && !ts.isBlock(node.body) && asyncFunction(node) ? node.body : undefined;
    if (returned !== undefined && asyncFunction(ts.isReturnStatement(node) ? enclosingFunction(node) : node)) {
      const value = skipParentheses(returned);
      if (ts.isCallExpression(value) || ts.isNewExpression(value)) flag(node);
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isElementAccessExpression(callee) ? literalName(callee.argumentExpression) : undefined;
      if (method !== undefined && METHODS.has(method)) flag(node);
    }
    ts.forEachChild(node, visit);
  };
  for (const node of nodes) visit(node);
  return found;
}

/** Every violation in the covered sources, or in `override` text standing in for one file. */
export function guardViolations(override = {}) {
  const found = [];
  for (const [file, names] of Object.entries(COVERED)) {
    const text = override[file] ?? sourceText(file);
    found.push(...violationsIn(`${file} ${names.join(',')}`, parse(file, text), coveredNodes(file, text)));
  }
  return found;
}

/** The covered list as docs/analysis-aggregations.md states it, in the fenced block after its `intrinsics-guard:covered` marker. */
export function documentedCovered() {
  const docs = readFileSync(new URL('../docs/analysis-aggregations.md', import.meta.url), 'utf8');
  const block = /intrinsics-guard:covered[^\n]*\n```text\n([\s\S]*?)\n```/.exec(docs);
  if (!block) throw new Error('docs/analysis-aggregations.md has no covered list');
  return Object.fromEntries(block[1].split('\n').map(line => {
    const [file, names] = line.split(': ');
    return [file, names.split(', ')];
  }));
}
