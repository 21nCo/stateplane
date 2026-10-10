import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffManifests } from '@mcpfn/core';

// The MCP manifest is a public contract. Review the printed diff with
// `pnpm mcp:manifest`, which builds @stateplane/mcp and its workspace
// dependencies first, then write it with `pnpm mcp:manifest --write`; the
// contract test rejects any unreviewed change. This script never builds or
// spawns anything itself, and it refuses a dist older than its source.
const packages = fileURLToPath(new URL('../packages/', import.meta.url));
const newest = async dir => {
  const files = (await readdir(dir, { withFileTypes: true, recursive: true })).filter(entry => entry.isFile());
  const times = await Promise.all(files.map(entry => stat(join(entry.parentPath, entry.name)).then(info => info.mtimeMs)));
  return Math.max(0, ...times);
};
for (const name of ['contracts', 'application', 'auth', 'mcp']) {
  const built = await stat(join(packages, name, 'dist/index.js')).then(info => info.mtimeMs, () => 0);
  if (built < await newest(join(packages, name, 'src')))
    throw new Error(`packages/${name}/dist is missing or older than its source; run pnpm mcp:manifest`);
}
const { stateplaneMcpDeclaration } = await import('../packages/mcp/dist/index.js');
const target = new URL('../contracts/mcp-manifest.json', import.meta.url);
const manifest = stateplaneMcpDeclaration().manifest();
const committed = await readFile(target, 'utf8').then(JSON.parse, () => null);
if (committed) console.log(JSON.stringify(diffManifests(committed, manifest), null, 2));
if (process.argv.includes('--write')) await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
