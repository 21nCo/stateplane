import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { diffManifests } from '@mcpfn/core';

// The MCP manifest is a public contract. Review the printed diff, then write
// it with --write; the contract test rejects any unreviewed change. The
// declaration is built from the current source first, never a stale dist.
const built = spawnSync('pnpm', ['--filter', '@stateplane/mcp...', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (built.status !== 0) throw new Error('building @stateplane/mcp failed');
const { stateplaneMcpDeclaration } = await import('../packages/mcp/dist/index.js');
const target = new URL('../contracts/mcp-manifest.json', import.meta.url);
const manifest = stateplaneMcpDeclaration().manifest();
const committed = await readFile(target, 'utf8').then(JSON.parse, () => null);
if (committed) console.log(JSON.stringify(diffManifests(committed, manifest), null, 2));
if (process.argv.includes('--write')) await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
