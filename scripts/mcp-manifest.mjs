import { readFile, writeFile } from 'node:fs/promises';
import { diffManifests } from '@mcpfn/core';
import { stateplaneMcpDeclaration } from '../packages/mcp/dist/index.js';

// The MCP manifest is a public contract. Review the printed diff, then write
// it with --write; the contract test rejects any unreviewed change.
const target = new URL('../contracts/mcp-manifest.json', import.meta.url);
const manifest = stateplaneMcpDeclaration().manifest();
const committed = await readFile(target, 'utf8').then(JSON.parse, () => null);
if (committed) console.log(JSON.stringify(diffManifests(committed, manifest), null, 2));
if (process.argv.includes('--write')) await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
