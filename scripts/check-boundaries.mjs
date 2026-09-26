import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const requireFromApp = createRequire(join(root, 'app/package.json'));
const { parse: parseSvelte } = requireFromApp('svelte/compiler');
const roles = new Map([
  ['contracts', []], ['application', ['contracts']], ['postgres', ['contracts']],
  ['auth', ['contracts']], ['storage', ['contracts']], ['retrieval', ['contracts']],
  ['workers', ['application', 'contracts']], ['api', ['application', 'auth']],
  ['mcp', ['application', 'auth']], ['cli', ['contracts']], ['testing', ['contracts']],
  ['read-model', []]
]);

async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (/\.(?:ts|js|svelte)$/.test(entry.name)) result.push(path);
  }
  return result;
}

function markupSpecifiers(fragment) {
  const result = [];
  const seen = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.type === 'ImportExpression' && typeof value.source?.value === 'string') result.push(value.source.value);
    if (value.type === 'CallExpression' && value.callee?.name === 'require' && typeof value.arguments?.[0]?.value === 'string') result.push(value.arguments[0].value);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(fragment);
  return result;
}

export function moduleSpecifiers(path, source) {
  const result = [];
  const svelte = path.endsWith('.svelte') ? parseSvelte(source, { modern: true, filename: path }) : null;
  const segments = svelte ? [svelte.module, svelte.instance].filter(Boolean).map(script => source.slice(script.content.start, script.content.end)) : [source];
  for (const script of segments) {
    const ast = ts.createSourceFile(path.endsWith('.svelte') ? `${path}.ts` : path, script, ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length) throw new Error(`${path}: invalid script syntax`);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        result.push(node.moduleSpecifier.text);
      } else if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression)) {
        result.push(node.expression.text);
      } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        result.push(node.arguments[0].text);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        result.push(node.argument.literal.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  if (svelte) result.push(...markupSpecifiers(svelte.fragment));
  return result;
}

export function isBrowserSource(rel) {
  if (!rel.startsWith('app/src/')) return false;
  const name = rel.split('/').at(-1);
  if (/\.server\.[cm]?[jt]s$/.test(name) || /^\+server\.[cm]?[jt]s$/.test(name)) return false;
  return !rel.startsWith('app/src/lib/server/');
}

export function sourceProblems(path, source, base = root) {
  const problems = [];
  const rel = relative(base, path);
  const role = rel.startsWith('packages/') ? rel.split('/')[1] : null;
  const browser = isBrowserSource(rel);
  if (role && !roles.has(role)) problems.push(`${rel}: unknown package role ${role}`);
  for (const specifier of moduleSpecifiers(path, source)) {
    const local = specifier.startsWith('.') ? relative(base, resolve(dirname(path), specifier)) : '';
    const target = specifier.match(/^@stateplane\/([^/]+)/)?.[1] ?? local.match(/^packages\/([^/]+)/)?.[1];
    if (role && target && target !== role && !roles.get(role)?.includes(target)) problems.push(`${rel}: forbidden dependency ${specifier}`);
    if (browser && target && target !== 'contracts') problems.push(`${rel}: browser imports ${specifier}`);
    const serverLocal = /^app\/src\/lib\/server(?:\/|$)/.test(local) || /\.server(?:\.|$)/.test(local) || /\/\+server(?:\.|$)/.test(local);
    if (browser && (/^(?:node:|pg$|@authfn\/|@mcpfn\/|@superfunctions\/|@datafn\/|\$env\/(?:static|dynamic)\/private|\$lib\/server(?:\/|$))/.test(specifier) || serverLocal)) {
      problems.push(`${rel}: browser imports server package ${specifier}`);
    }
    if (role === 'contracts' && /^(?:node:|pg$|@authfn\/|@mcpfn\/|@superfunctions\/|@datafn\/)/.test(specifier)) problems.push(`${rel}: contracts import runtime ${specifier}`);
  }
  return problems;
}

export async function checkBoundaries(base = root) {
  const problems = [];
  const packageNames = await readdir(join(base, 'packages'), { withFileTypes: true });
  for (const entry of packageNames.filter(item => item.isDirectory())) {
    const role = entry.name;
    if (!roles.has(role)) { problems.push(`packages/${role}: unknown package role`); continue; }
    const pkg = JSON.parse(await readFile(join(base, 'packages', role, 'package.json'), 'utf8'));
    const declared = Object.keys(pkg.dependencies ?? {}).filter(name => name.startsWith('@stateplane/')).map(name => name.split('/')[1]);
    const allowed = roles.get(role);
    if (declared.length !== allowed.length || declared.some(name => !allowed.includes(name))) {
      problems.push(`${role}: dependency declaration differs from allowed graph`);
    }
  }
  const files = [...await walk(join(base, 'packages')), ...await walk(join(base, 'app/src'))];
  for (const path of files) {
    try { problems.push(...sourceProblems(path, await readFile(path, 'utf8'), base)); }
    catch (error) { problems.push(`${relative(base, path)}: ${error.message}`); }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await checkBoundaries();
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
  else console.log('Package and browser boundaries pass');
}
