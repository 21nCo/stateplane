import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const requirePackage = createRequire(import.meta.url);
const names = ['@authfn/core', '@authfn/api-keys', '@authfn/multi-region', '@mcpfn/core', '@mcpfn/auth', '@mcpfn/testing', '@datafn/core', '@datafn/server', '@superfunctions/db', '@superfunctions/storage-r2', '@superfunctions/observability'];

/** Detect a CommonJS root condition anywhere in a package export map. */
function hasRequireCondition(value) {
  return value && typeof value === 'object' && ('require' in value || Object.values(value).some(hasRequireCondition));
}

/** Load both advertised root entrypoints as an external consumer would. */
export async function verifyRoot(name, conditions, importModule = specifier => import(specifier), requireModule = requirePackage) {
  const imported = await importModule(name);
  if (!Object.keys(imported).length) throw new Error(`Empty package entry: ${name}`);
  if (hasRequireCondition(conditions)) {
    const required = requireModule(name);
    if (!Object.keys(required).length) throw new Error(`Empty CommonJS package entry: ${name}`);
  }
}

/** Check the packed paths and root imports of every qualified dependency. */
export async function qualifyExports() {
  for (const name of names) {
    const path = resolve(root, 'node_modules', name, 'package.json');
    const pkg = JSON.parse(await readFile(path, 'utf8'));
    for (const [entry, conditions] of Object.entries(pkg.exports)) {
      /** Verify each conditional export target exists in the packed package. */
      async function visit(value) {
        if (typeof value === 'string') {
          await stat(resolve(path, '..', value));
        } else for (const child of Object.values(value)) await visit(child);
      }
      await visit(conditions);
      if (entry === '.') {
        try {
          await verifyRoot(name, conditions);
        } catch (error) {
          if (name !== '@datafn/server' || pkg.version !== '0.2.0' || error.code !== 'ERR_REQUIRE_ASYNC_MODULE') throw error;
          console.warn(`${name}@${pkg.version}: CommonJS root unsupported on Node 22 (upstream top-level await)`);
        }
      }
    }
    console.log(`${name}@${pkg.version}: ${Object.keys(pkg.exports).join(', ')}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await qualifyExports();
