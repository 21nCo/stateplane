import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { currentCleanHead, qualificationRailwayServiceName } from './qualification-artifact.mjs';
import { validateTopology } from './topology.mjs';

const root = resolve(import.meta.dirname, '..');
const [name] = process.argv.slice(2);
try {
  const head = await currentCleanHead(root);
  const topology = validateTopology(JSON.parse(await readFile(resolve(root, 'deployment/topology.json'), 'utf8')));
  console.log(qualificationRailwayServiceName(name, head, topology));
} catch {
  console.error('Usage: node scripts/qualification-railway-name.mjs s4-<full-head>-<d|p>-<apse|use|euw> (clean checkout required)');
  process.exitCode = 2;
}
