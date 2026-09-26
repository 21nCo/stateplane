import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const roles = new Map([
  ['contracts', []], ['application', ['contracts']], ['postgres', ['contracts']],
  ['auth', ['contracts']], ['storage', ['contracts']], ['retrieval', ['contracts']],
  ['workers', ['application']], ['api', ['application', 'auth']],
  ['mcp', ['application', 'auth']], ['cli', ['contracts']], ['testing', ['contracts']],
  ['read-model', []]
]);
const problems = [];
async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (/\.(?:ts|js|svelte)$/.test(entry.name)) result.push(path);
  }
  return result;
}
for (const [role, allowed] of roles) {
  const pkg = JSON.parse(await readFile(join(root, 'packages', role, 'package.json'), 'utf8'));
  const declared = Object.keys(pkg.dependencies ?? {}).filter(name => name.startsWith('@stateplane/')).map(name => name.split('/')[1]);
  if (declared.join(',') !== allowed.join(',')) problems.push(`${role}: dependency declaration differs from allowed graph`);
}
const files = [...await walk(join(root, 'packages')), ...await walk(join(root, 'app', 'src'))];
for (const path of files) {
  const source = await readFile(path, 'utf8');
  const rel = relative(root, path);
  const role = rel.startsWith('packages/') ? rel.split('/')[1] : null;
  const browser = rel.startsWith('app/src/') && !rel.includes('/+server.') && !rel.includes('/server/');
  const staticImports = [...source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map(match => match[1]);
  const dynamicImports = [...source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
  const imports = [...staticImports, ...dynamicImports];
  for (const specifier of imports) {
    const local = specifier.startsWith('.') ? relative(root, resolve(path, '..', specifier)) : '';
    const target = specifier.match(/^@stateplane\/([^/]+)/)?.[1] ?? local.match(/^packages\/([^/]+)/)?.[1];
    if (role && target && !roles.get(role).includes(target)) problems.push(`${rel}: forbidden dependency ${specifier}`);
    if (browser && target && target !== 'contracts') problems.push(`${rel}: browser imports ${specifier}`);
    if (browser && (/^(?:node:|pg$|@authfn\/|@mcpfn\/|@superfunctions\/|@datafn\/|\$env\/(?:static|dynamic)\/private|\$lib\/server)/.test(specifier) || /(?:\/server\/|\.server\.)/.test(local))) problems.push(`${rel}: browser imports server package ${specifier}`);
    if (role === 'contracts' && /^(?:node:|pg$|@authfn\/|@mcpfn\/|@superfunctions\/|@datafn\/)/.test(specifier)) problems.push(`${rel}: contracts import runtime ${specifier}`);
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log('Package and browser boundaries pass');
