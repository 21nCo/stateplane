import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { currentCleanHead, qualificationConfig } from './qualification-artifact.mjs';

const [name, hyperdriveId] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');
let config;
try {
  config = await qualificationConfig(root, name, hyperdriveId, await currentCleanHead(root));
} catch {
  console.error('Usage: node scripts/qualification-config.mjs s4-<full-head>-<d|p>-<apse|use|euw> <disposable-hyperdrive-id> (name <= 54 characters)');
  process.exit(2);
}
const out = resolve(root, '.data/qualification');
await mkdir(out, { recursive: true });
await writeFile(resolve(out, `${name}.json`), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(relative(root, resolve(out, `${name}.json`)));
