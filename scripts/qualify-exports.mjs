import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const names = ['@authfn/core', '@authfn/api-keys', '@authfn/multi-region', '@mcpfn/core', '@mcpfn/auth', '@mcpfn/testing', '@datafn/core', '@datafn/server', '@superfunctions/db', '@superfunctions/storage-r2', '@superfunctions/observability'];
for (const name of names) {
  const path = resolve(root, 'node_modules', name, 'package.json');
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  for (const [entry, conditions] of Object.entries(pkg.exports)) {
    async function visit(value) {
      if (typeof value === 'string') {
        const target = resolve(path, '..', value);
        await stat(target);
      } else for (const child of Object.values(value)) await visit(child);
    }
    await visit(conditions);
    if (entry === '.') {
      const imported = await import(name);
      if (!Object.keys(imported).length) throw Error(`Empty package entry: ${name}`);
    }
  }
  console.log(`${name}@${pkg.version}: ${Object.keys(pkg.exports).join(', ')}`);
}
