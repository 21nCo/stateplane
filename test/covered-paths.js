import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  'sources.ts': ['serialized', 'fields', 'within', 'handBack', 'transact']
};

/** Globals a covered path never names: their statics, constructors and functions can all be replaced after load. */
const GLOBALS = new Set(['globalThis', 'Error', 'Reflect', 'Object', 'Array', 'Number', 'String', 'Boolean', 'BigInt', 'Symbol', 'JSON',
  'Math', 'Buffer', 'Intl', 'performance', 'Date', 'Promise', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask']);
/** Every method of the built-in prototypes, by name: a covered path never calls one, by dot or by computed name. */
const METHODS = new Set([Array, String, RegExp, Date, Map, Set, WeakMap, WeakSet, Promise, Function, Object, Number, Boolean, Symbol,
  BigInt, Error].flatMap(type => Object.getOwnPropertyNames(type.prototype)
  .filter(name => name !== 'constructor' && typeof Object.getOwnPropertyDescriptor(type.prototype, name).value === 'function')));

const PACKAGE = new URL('../packages/postgres/', import.meta.url);
export const sourceText = (file, dir = 'src') => readFileSync(new URL(`${dir}/${file}`, PACKAGE), 'utf8');
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
  file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
const nameOf = node => node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) ? node.name.text : undefined;
/** A load-time capture's value: a global or a member of one, `Map.prototype.get`, never a function or a call. */
const captureShape = node => node !== undefined && (ts.isIdentifier(node) || (ts.isPropertyAccessExpression(node) && captureShape(node.expression)));
const captures = statement => ts.isVariableStatement(statement) ? statement.declarationList.declarations
  .filter(item => /^native/.test(nameOf(item) ?? '')) : [];
const isCapture = statement => ts.isVariableStatement(statement) && captures(statement).length === statement.declarationList.declarations.length
  && captures(statement).every(item => captureShape(item.initializer));

/** The nodes `names` cover in `file`'s `text`, a source (.ts) or its build (.js); a name that matches nothing fails. */
export function coveredNodes(file, text, names = COVERED[file], root = parse(file, text)) {
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

const K = ts.SyntaxKind;
const unwrap = node => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
  || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) ? unwrap(node.expression) : node;
const enclosingFunction = node => { let at = node.parent; while (at && !ts.isFunctionLike(at)) at = at.parent; return at; };
const asyncFunction = node => node !== undefined && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) !== 0;
const literalName = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;

/** The values `name` is given in `scope`: its declarations' initializers and the right sides of its assignments. */
function bindings(scope, name) {
  const found = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && nameOf(node) === name && node.initializer) found.push(node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === K.EqualsToken && ts.isIdentifier(node.left) && node.left.text === name)
      found.push(node.right);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}
/** Whether a returned expression can be a call's promise: a call, or a branch, operand or local alias of one. */
function promiseValued(node, scope, seen = new Set()) {
  const value = unwrap(node);
  if (ts.isCallExpression(value) || ts.isNewExpression(value)) return true;
  if (ts.isConditionalExpression(value)) return promiseValued(value.whenTrue, scope, seen) || promiseValued(value.whenFalse, scope, seen);
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === K.CommaToken) return promiseValued(value.right, scope, seen);
  if (ts.isBinaryExpression(value) && [K.BarBarToken, K.AmpersandAmpersandToken, K.QuestionQuestionToken].includes(value.operatorToken.kind))
    return promiseValued(value.left, scope, seen) || promiseValued(value.right, scope, seen);
  if (!ts.isIdentifier(value) || seen.has(value.text)) return false;
  seen.add(value.text);
  return bindings(scope, value.text).some(bound => promiseValued(bound, scope, seen));
}
/** An async function resolves a returned promise through a lookup of its `then`. */
function returnsPromise(node) {
  const fn = ts.isReturnStatement(node) ? enclosingFunction(node) : node;
  const returned = ts.isReturnStatement(node) ? node.expression
    : ts.isArrowFunction(node) && !ts.isBlock(node.body) ? node.body : undefined;
  return returned !== undefined && asyncFunction(fn) && promiseValued(returned, fn);
}
/** A call of a built-in prototype method, by dot or computed name. */
function callsMethod(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
    : ts.isElementAccessExpression(callee) ? literalName(callee.argumentExpression) : undefined;
  return method !== undefined && METHODS.has(method);
}
/** A reference to a live global, rather than a name that merely spells one. */
function namesGlobal(node) {
  if (!ts.isIdentifier(node) || !GLOBALS.has(node.text)) return false;
  const parent = node.parent;
  const named = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node)
    || ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)
      || ts.isPropertyDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node)
    // A class's `extends` clause is evaluated once, when the module loads.
    || (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent));
  return !named;
}
/** Iteration that looks up an operand's inherited `Symbol.iterator`: for-of, spread, array destructuring. */
const iterates = node => ts.isForOfStatement(node) || ts.isSpreadElement(node) || ts.isArrayBindingPattern(node)
  || (ts.isBinaryExpression(node) && node.operatorToken.kind === K.EqualsToken && ts.isArrayLiteralExpression(node.left));

const COERCING = new Set([K.PlusToken, K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken, K.AsteriskAsteriskToken,
  K.PlusEqualsToken, K.MinusEqualsToken, K.AsteriskEqualsToken, K.SlashEqualsToken, K.PercentEqualsToken, K.LessThanToken,
  K.GreaterThanToken, K.LessThanEqualsToken, K.GreaterThanEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken]);
/** Operands converted to a primitive, which an object's inherited `toString`, `valueOf` or `Symbol.toPrimitive` would decide. */
function coerced(node) {
  if (ts.isTemplateSpan(node)) return [node.expression];
  if (ts.isBinaryExpression(node) && COERCING.has(node.operatorToken.kind)) return [node.left, node.right];
  if (ts.isPrefixUnaryExpression(node) && [K.PlusToken, K.MinusToken, K.TildeToken].includes(node.operator)) return [node.operand];
  if (ts.isElementAccessExpression(node)) return [node.argumentExpression];
  return [];
}
const PRIMITIVE = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike
  | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.EnumLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined;
const primitive = type => type.isUnion() ? type.types.every(primitive) : (type.flags & PRIMITIVE) !== 0;

/** Every live built-in the nodes reach, whatever its spacing or property syntax, and every value they coerce that is not
 * typed a primitive. */
function violationsIn(label, root, nodes, checker) {
  const found = [];
  const flag = node => found.push(`${label}: ${node.getText(root).replace(/\s+/g, ' ').slice(0, 120)}`);
  const visit = node => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (namesGlobal(node)) flag(node.parent);
    if ((ts.isReturnStatement(node) || ts.isArrowFunction(node)) && returnsPromise(node)) flag(node);
    if (callsMethod(node) || iterates(node)) flag(node);
    for (const operand of coerced(node)) if (!primitive(checker.getTypeAtLocation(operand))) flag(operand);
    ts.forEachChild(node, visit);
  };
  for (const node of nodes) visit(node);
  return found;
}

let checked;
/** The package's program, type-checked, with `override` text standing in for its files' sources. */
function program(override) {
  if (checked === undefined) {
    const config = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL('tsconfig.json', PACKAGE)), {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
    checked = ts.createProgram(config.fileNames, config.options);
  }
  const replaced = Object.entries(override);
  if (replaced.length === 0) return checked;
  const host = ts.createCompilerHost(checked.getCompilerOptions());
  const read = host.getSourceFile;
  host.getSourceFile = (name, language, ...rest) => {
    const text = replaced.find(([file]) => name.replace(/\\/g, '/').endsWith(`/src/${file}`))?.[1];
    return text !== undefined ? ts.createSourceFile(name, text, language, true) : checked.getSourceFile(name) ?? read.call(host, name, language, ...rest);
  };
  return ts.createProgram(checked.getRootFileNames(), checked.getCompilerOptions(), host, checked);
}

/** Every violation in the covered sources, or in `override` text standing in for one file. */
export function guardViolations(override = {}) {
  const found = [];
  const built = program(override);
  const checker = built.getTypeChecker();
  for (const [file, names] of Object.entries(COVERED)) {
    const root = built.getSourceFiles().find(source => source.fileName.endsWith(`/src/${file}`));
    const label = `${file} ${names.join(',')}`;
    // A capture is exempt from the walk only as a plain reference to a built-in; anything else named native… is code.
    for (const statement of root.statements) for (const item of captures(statement))
      if (!captureShape(item.initializer)) found.push(`${label}: ${item.getText(root).slice(0, 120)}`);
    found.push(...violationsIn(label, root, coveredNodes(file, root.text, names, root), checker));
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
