import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'stateplane-consumer-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe', env: process.env });
  if (result.status !== 0) throw Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
try {
  const names = ['contracts', 'application', 'auth', 'api', 'read-model'];
  const tarballs = [];
  for (const name of names) {
    const tarball = join(temp, `${name}.tgz`);
    run('pnpm', ['pack', '--out', tarball], join(root, 'packages', name));
    tarballs.push(tarball);
  }
  await writeFile(join(temp, 'package.json'), JSON.stringify({ name: 'stateplane-external-consumer', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], temp);
  await writeFile(join(temp, 'consumer.mjs'), `
import { healthResponse } from '@stateplane/api';
import { readModelSchema } from '@stateplane/read-model';
import { validateSchema } from '@datafn/core';
if ((await healthResponse().json()).status !== 'scaffold') throw Error('API export failed');
if (readModelSchema.resources[0].name !== 'spacePlacements') throw Error('fixed schema export failed');
if (!validateSchema(readModelSchema)) throw Error('DataFn schema rejected');
`);
  run('node', ['consumer.mjs'], temp);
  await writeFile(join(temp, 'consumer.ts'), `import type { RecordRef } from '@stateplane/contracts';\nimport type { HttpDependencies } from '@stateplane/api';\nconst ref: RecordRef | undefined = undefined;\nconst deps: HttpDependencies | undefined = undefined;\nvoid ref; void deps;\n`);
  await writeFile(join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, skipLibCheck: true, noEmit: true }, files: ['consumer.ts'] }));
  run(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], temp);
  console.log('Packed Stateplane packages import and typecheck in an isolated npm consumer');
} finally {
  await rm(temp, { recursive: true, force: true });
}
