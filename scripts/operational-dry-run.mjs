import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { operationalConfig } from './operational-binding.mjs';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const output = join(root, '.data/operational-dry-run');
await mkdir(output, { recursive: true });
const configPath = join(output, 'wrangler.json');
await writeFile(configPath, JSON.stringify(operationalConfig(`s4o-${'a'.repeat(40)}-d-ctl`,
  'b'.repeat(32), 'stateplane_dev_control', 'operational_reader')), { mode: 0o600 });
const { stdout } = await run(process.execPath, [join(root, 'app/node_modules/wrangler/bin/wrangler.js'),
  'deploy', '--config', configPath, '--dry-run', '--outdir', join(output, 'bundle')],
{ cwd: root, maxBuffer: 1024 * 1024 });
process.stdout.write(stdout);
