import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'stateplane-consumer-'));
/** Run a package command inside the isolated external consumer. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe', env: process.env, shell: process.platform === 'win32' && ['pnpm', 'npm'].includes(command) });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
try {
  const names = ['contracts', 'application', 'auth', 'api', 'read-model', 'postgres', 'workers'];
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
import { parseRevision } from '@stateplane/contracts';
import { canonicalJsonObject } from '@stateplane/postgres';
import { validateSchema } from '@datafn/core';
if ((await healthResponse().json()).status !== 'scaffold') throw Error('API export failed');
if (readModelSchema.resources[0].name !== 'spacePlacements') throw Error('fixed schema export failed');
if (!validateSchema(readModelSchema)) throw Error('DataFn schema rejected');
if (parseRevision(1) !== 1) throw Error('revision export failed');
if (canonicalJsonObject('{"answer":42}') !== '{"answer":42}') throw Error('Postgres export failed');
`);
  run('node', ['consumer.mjs'], temp);
  await writeFile(join(temp, 'consumer.ts'), `import { parseRevision, type RecordRef, type Revision, type CollectionId, type SpaceId } from '@stateplane/contracts';
import type { HttpDependencies } from '@stateplane/api';
import type { AuthorityScope, AuthorityTransaction, RecordChange, PostgresAuthority, Receipt } from '@stateplane/postgres';
import type { ProjectionJob } from '@stateplane/workers';
const ref: RecordRef | undefined = undefined;
const deps: HttpDependencies | undefined = undefined;
const revision: Revision = parseRevision(1);
// @ts-expect-error A raw number is not a validated revision.
const invalid: Revision = 0;
declare const job: ProjectionJob;
const collection: CollectionId = job.ref.collectionId;
declare const tx: AuthorityTransaction;
declare const repository: PostgresAuthority;
declare const spaceId: SpaceId;
const scope: AuthorityScope = { spaceId, collectionId: collection, principalId: 'owner', credentialId: 'credential',
  capability: 'records:write', policyVersion: 1, placementGeneration: 1 };
const change: RecordChange = { operation: 'create', idempotencyKey: 'retry', requestDigest: 'a'.repeat(64), canonicalData: '{}' };
const receipt: Receipt = await repository.mutate(scope, change);
// @ts-expect-error An authority mutation must include a request fingerprint.
const unsafe: RecordChange = { operation: 'create', idempotencyKey: 'retry', canonicalData: '{}' };
void tx; void receipt; void unsafe; void ref; void deps; void revision; void invalid;
`);
  await writeFile(join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, skipLibCheck: true, noEmit: true }, files: ['consumer.ts'] }));
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], temp);
  console.log('Packed Stateplane packages import and typecheck in an isolated npm consumer');
} finally {
  await rm(temp, { recursive: true, force: true });
}
