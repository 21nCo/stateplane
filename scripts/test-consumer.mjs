import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { validateSchema } from '@datafn/core';
if ((await healthResponse().json()).status !== 'scaffold') throw Error('API export failed');
if (readModelSchema.resources[0].name !== 'spacePlacements') throw Error('fixed schema export failed');
if (!validateSchema(readModelSchema)) throw Error('DataFn schema rejected');
if (parseRevision(1) !== 1) throw Error('revision export failed');
`);
  run('node', ['consumer.mjs'], temp);
  await writeFile(join(temp, 'consumer.ts'), `import { parseRevision, type RecordRef, type Revision, type CollectionId, type SpaceId } from '@stateplane/contracts';\nimport type { HttpDependencies } from '@stateplane/api';\nimport type { AuthorityTransaction, AuthorityReceiptIdentity } from '@stateplane/postgres';\nimport type { ProjectionJob } from '@stateplane/workers';\nconst ref: RecordRef | undefined = undefined;\nconst deps: HttpDependencies | undefined = undefined;\nconst revision: Revision = parseRevision(1);\n// @ts-expect-error A raw number is not a validated revision.\nconst invalid: Revision = 0;\ndeclare const job: ProjectionJob;\nconst collection: CollectionId = job.ref.collectionId;\ndeclare const tx: AuthorityTransaction;\ndeclare const spaceId: SpaceId;\nconst identity: AuthorityReceiptIdentity = { spaceId, credentialId: 'credential', operation: 'create', idempotencyKey: 'retry' };\nconst lookup = await tx.findReceipt(identity);\nif (lookup?.state === 'committed') {\n  const digest: string = lookup.receipt.requestDigest;\n  const response: unknown = lookup.receipt.response;\n  await tx.writeReceipt({ ...identity, ref: lookup.receipt.ref, requestDigest: digest, response });\n}\nif (lookup?.state === 'pending') { const pending: 'pending' = lookup.state; void pending; }\n// @ts-expect-error A receipt lookup needs the scoped operation and credential identity.\nvoid tx.findReceipt({ spaceId, idempotencyKey: 'retry' });\nvoid tx.reserveUnique; void tx.writeRecord; void tx.appendAudit; void tx.enqueueProjection;\nvoid ref; void deps; void revision; void invalid; void collection;\n`);
  await appendFile(join(temp, 'consumer.ts'), `
import type { AuthorityReceiptLookup } from '@stateplane/postgres';
if (lookup?.state === 'pending') { const original: CollectionId = lookup.collectionId; void original; }
const pendingReceipt: AuthorityReceiptLookup = { state: 'pending', collectionId: collection };
// @ts-expect-error A pending receipt without its original collection cannot be disclosed.
const unscopedPending: AuthorityReceiptLookup = { state: 'pending' };
void pendingReceipt; void unscopedPending;
`);
  await writeFile(join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, skipLibCheck: true, noEmit: true }, files: ['consumer.ts'] }));
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], temp);
  console.log('Packed Stateplane packages import and typecheck in an isolated npm consumer');
} finally {
  await rm(temp, { recursive: true, force: true });
}
