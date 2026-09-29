import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { currentCleanHead, qualificationRailwayServiceName } from './qualification-artifact.mjs';
import { validateTopology } from './topology.mjs';

const root = resolve(import.meta.dirname, '..');
const [name] = process.argv.slice(2);
const usage = 'Usage: node scripts/qualification-railway-name.mjs s4-<full-head>-<d|p>-<apse|use|euw> (clean checkout required)';
let stage = 'checkout';
try {
  const head = await currentCleanHead(root);
  stage = 'topology read';
  const source = await readFile(resolve(root, 'deployment/topology.json'), 'utf8');
  stage = 'topology parse';
  const parsed = JSON.parse(source);
  stage = 'topology validation';
  const topology = validateTopology(parsed);
  stage = 'name';
  console.log(qualificationRailwayServiceName(name, head, topology));
} catch (error) {
  let reason;
  if (stage === 'checkout') {
    reason = error?.message === 'Qualification requires a clean checked-out commit'
      ? error.message : 'Could not verify the clean checked-out commit';
  } else if (stage === 'topology read') {
    reason = 'Deployment topology could not be read';
  } else if (stage === 'topology parse') {
    reason = 'Deployment topology is invalid JSON';
  } else if (stage === 'topology validation') {
    const message = error?.message;
    reason = typeof message === 'string' && !message.includes('unsupported field') &&
      /^[A-Za-z0-9 _-]{1,160}$/.test(message)
      ? message : 'Deployment topology failed validation';
  } else {
    reason = 'Qualification name must identify a declared cell at the clean checked-out head';
  }
  console.error(`Error: ${reason}`);
  console.error(usage);
  process.exitCode = 2;
}
