import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'stateplane-consumer-'));
const pnpmCli=process.env.npm_execpath;
const npmCandidates=[join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),
  join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')];
const npmCli=npmCandidates.find(existsSync);
const systemPaths=process.platform==='win32'
  ? [join(process.env.SystemRoot??String.raw`C:\Windows`,'System32'),
    process.env.SystemRoot??String.raw`C:\Windows`]
  : ['/usr/bin','/bin'];
const trustedPath=[dirname(process.execPath),...systemPaths].join(delimiter);
/** Run a package command inside the isolated external consumer. */
function run(command, args, cwd) {
  const executable=['pnpm','npm'].includes(command) ? process.execPath : command;
  let parameters=args;
  if (command==='pnpm') parameters=[pnpmCli,...args];
  else if (command==='npm') parameters=[npmCli,...args];
  const env={...process.env};
  for (const key of Object.keys(env)) if (key.toLowerCase()==='path') delete env[key];
  env.PATH=trustedPath;
  const result = spawnSync(executable, parameters, { cwd, encoding: 'utf8', stdio: 'pipe', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
try {
  if (!pnpmCli || !isAbsolute(pnpmCli) || !existsSync(pnpmCli) || !npmCli || !isAbsolute(npmCli))
    throw new Error('Trusted pnpm/npm CLI paths are unavailable');
  // npm lifecycle scripts must not resolve a command from a writable caller PATH.
  const pathProbe=join(temp,'path-probe');
  const writablePath=join(pathProbe,'writable');
  await mkdir(writablePath,{recursive:true});
  await writeFile(join(pathProbe,'package.json'),JSON.stringify({name:'stateplane-path-probe',
    private:true,scripts:{probe:'node --version'}}));
  const fakeNode=join(writablePath,process.platform==='win32'?'node.cmd':'node');
  await writeFile(fakeNode,process.platform==='win32'?'@exit /b 73\r\n':'#!/bin/sh\nexit 73\n');
  if (process.platform!=='win32') await chmod(fakeNode,0o755);
  const callerPath=process.env.PATH;
  try {
    process.env.PATH=[writablePath,callerPath].filter(Boolean).join(delimiter);
    run('npm',['run','probe'],pathProbe);
  } finally {
    if (callerPath===undefined) delete process.env.PATH;
    else process.env.PATH=callerPath;
  }
  const names = ['contracts', 'application', 'auth', 'api', 'cli', 'read-model', 'postgres', 'workers'];
  const tarballs = [];
  for (const name of names) {
    const tarball = join(temp, `${name}.tgz`);
    run('pnpm', ['pack', '--out', tarball], join(root, 'packages', name));
    tarballs.push(tarball);
  }
  // The documented install names only the CLI tarball. Verify it without the
  // contracts tarball that the larger cross-package consumer installs below.
  const standalone=join(temp,'standalone');
  await mkdir(standalone);
  await writeFile(join(standalone,'package.json'),JSON.stringify({name:'stateplane-cli-only',private:true}));
  run('npm',['install','--offline','--no-audit','--no-fund',tarballs[names.indexOf('cli')]],standalone);
  const standaloneCli=join(standalone,'node_modules/@stateplane/cli/bin/stateplane.js');
  if (JSON.parse(run(process.execPath,[standaloneCli,'help'],standalone)).usage?.startsWith('stateplane ')!==true)
    throw new Error('CLI-only tarball did not launch');
  if (existsSync(join(standalone,'node_modules/@stateplane/contracts')))
    throw new Error('CLI-only install unexpectedly included private contracts');
  const standaloneEnv={...process.env,STATEPLANE_CONFIG_DIR:join(standalone,'config')};
  const endpoint=spawnSync(process.execPath,[standaloneCli,'config','endpoint','--url','http://127.0.0.1:43210/'],
    {cwd:standalone,env:standaloneEnv,encoding:'utf8'});
  if (endpoint.status!==0) {
    let diagnostic='';
    if (process.platform==='win32') {
      const powershell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
      const script=join(standalone,'node_modules','@stateplane','cli','bin','secure-acl.ps1');
      const caller=spawnSync('whoami',['/user'],{encoding:'utf8'});
      const probe=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
        '-File',script,'-TargetPath',standaloneEnv.STATEPLANE_CONFIG_DIR,'-Action','diagnose'],
      {encoding:'utf8'});
      diagnostic=`caller=${caller.stdout.trim()} helper=${probe.status} `+
        `acl=${probe.stdout.trim()} helperError=${probe.stderr.trim()}`;
    }
    throw new Error(`CLI-only endpoint bootstrap failed: status=${endpoint.status} ${endpoint.stderr} ${diagnostic}`);
  }
  const imported=spawnSync(process.execPath,[standaloneCli,'auth','import','--token-stdin','--store','file'],
    {cwd:standalone,env:standaloneEnv,encoding:'utf8',input:'standalone-disposable-token\n'});
  if (imported.status!==0 || (imported.stdout+imported.stderr).includes('standalone-disposable-token'))
    throw new Error('CLI-only credential import failed or exposed a secret');
  const standaloneShown=spawnSync(process.execPath,[standaloneCli,'config','show'],
    {cwd:standalone,env:standaloneEnv,encoding:'utf8'});
  if (standaloneShown.status!==0 || JSON.parse(standaloneShown.stdout).endpoint!=='http://127.0.0.1:43210/' ||
      (standaloneShown.stdout+standaloneShown.stderr).includes('standalone-disposable-token'))
    throw new Error('CLI-only configuration read failed or exposed a secret');
  const signedOut=spawnSync(process.execPath,[standaloneCli,'auth','logout'],
    {cwd:standalone,env:standaloneEnv,encoding:'utf8'});
  if (signedOut.status!==0 || existsSync(join(standalone,'config','token')))
    throw new Error('CLI-only logout left a credential');
  await writeFile(join(temp, 'package.json'), JSON.stringify({ name: 'stateplane-external-consumer', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], temp);
  await writeFile(join(temp, 'consumer.mjs'), `
import { healthResponse } from '@stateplane/api';
import { readModelSchema } from '@stateplane/read-model';
import { parseRevision } from '@stateplane/contracts';
import { canonicalJsonObject } from '@stateplane/postgres';
import { validateSchema } from '@datafn/core';
if ((await healthResponse().json()).status !== 'scaffold') throw new Error('API export failed');
if (readModelSchema.resources[0].name !== 'spacePlacements') throw new Error('fixed schema export failed');
if (!validateSchema(readModelSchema)) throw new Error('DataFn schema rejected');
if (parseRevision(1) !== 1) throw new Error('revision export failed');
if (canonicalJsonObject('{"answer":42}') !== '{"answer":42}') throw new Error('Postgres export failed');
`);
  run('node', ['consumer.mjs'], temp);
  const installedCli = join(temp, 'node_modules/@stateplane/cli/bin/stateplane.js');
  const cliHelp = run(process.execPath, [installedCli, 'help'], temp);
  if (JSON.parse(cliHelp).usage?.startsWith('stateplane ') !== true) throw new Error('Installed CLI executable failed');
  const cliEnv = { ...process.env, STATEPLANE_CONFIG_DIR: join(temp, 'cli-config') };
  const setup = spawnSync(process.execPath, [installedCli, 'config', 'endpoint', '--url', 'http://127.0.0.1:43210/'],
    { cwd: temp, env: cliEnv, encoding: 'utf8' });
  if (setup.status !== 0) {
    let aclDiagnostic='';
    if (process.platform==='win32') {
      const powershell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
      const script=join(temp,'node_modules','@stateplane','cli','bin','secure-acl.ps1');
      const runner=spawnSync('whoami',['/user'],{cwd:temp,encoding:'utf8'});
      const moduleProbe=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',
        '$PSVersionTable.PSVersion.ToString(); try { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; "module=loaded" } catch { "module=" + $_.Exception.GetType().FullName + ":" + $_.Exception.Message }'],
      {cwd:temp,encoding:'utf8'});
      aclDiagnostic+=`runner=${runner.stdout.trim()} node=${process.execPath} powershell=${powershell} `+
        `module=${moduleProbe.stdout.trim()} moduleError=${moduleProbe.stderr.trim()}; `;
      for (const name of ['cli-config','cli-config/config.lock.sqlite','cli-config/config.json']) {
        const target=join(temp,name);
        if (!existsSync(target)) { aclDiagnostic+=`${name}: absent; `; continue; }
        const check=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
          '-File',script,'-TargetPath',target,'-Action','verify'],{cwd:temp,encoding:'utf8'});
        const details=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
          '-File',script,'-TargetPath',target,'-Action','diagnose'],{cwd:temp,encoding:'utf8'});
        const rawAcl=spawnSync(join(process.env.SystemRoot,'System32','icacls.exe'),[target],
          {cwd:temp,encoding:'utf8'});
        aclDiagnostic+=`${name}: verify=${check.status} signal=${check.signal} verifyError=${check.stderr.trim()} `+
          `diagnose=${details.status} acl=${details.stdout.trim()} diagnoseError=${details.stderr.trim()} `+
          `icacls=${rawAcl.stdout.trim()} icaclsError=${rawAcl.stderr.trim()}; `;
      }
    }
    throw new Error(`Installed CLI configuration failed: status=${setup.status} signal=${setup.signal} error=${setup.error?.code??'none'} ${setup.stderr} ${aclDiagnostic}`);
  }
  const login = spawnSync(process.execPath, [installedCli, 'auth', 'import', '--token-stdin', '--store', 'file'],
    { cwd: temp, env: cliEnv, encoding: 'utf8', input: 'generic-consumer-token\n' });
  if (login.status !== 0 || (login.stdout + login.stderr).includes('generic-consumer-token'))
    throw new Error('Installed CLI secure bootstrap failed');
  const shown = spawnSync(process.execPath, [installedCli, 'config', 'show'], { cwd: temp, env: cliEnv, encoding: 'utf8' });
  if (shown.status !== 0 || shown.stdout.includes('generic-consumer-token') ||
      JSON.parse(shown.stdout).endpoint !== 'http://127.0.0.1:43210/') throw new Error('Installed CLI exported a secret or lost endpoint');
  const record = ['records', 'create', '--space', 'sp_a', '--collection', 'entries',
    '--idempotency-key', 'invalid', '--data', '{}'];
  for (const args of [
    [...record, '--key', ''],
    [...record, '--file', ''],
    ['records', 'create', '--space', 'sp_a', '--collection', 'entries',
      '--idempotency-key', 'invalid', '--data', '', '--file', 'record.json']
  ]) {
    const rejected = spawnSync(process.execPath, [installedCli, ...args], { cwd: temp, env: cliEnv, encoding: 'utf8' });
    if (rejected.status !== 1 || JSON.parse(rejected.stderr).error.code !== 'INVALID_ARGUMENT' ||
        (rejected.stdout + rejected.stderr).includes('generic-consumer-token'))
      throw new Error('Installed CLI accepted malformed record input or exposed a token');
  }
  if (process.platform==='win32') {
    const tokenFile=join(temp,'cli-config','token');
    const icacls=join(process.env.SystemRoot,'System32','icacls.exe');
    const opened=spawnSync(icacls,[tokenFile,'/grant','*S-1-1-0:R'],{cwd:temp,encoding:'utf8'});
    if (opened.status!==0) throw new Error(`Windows ACL probe failed: ${opened.stderr}`);
    const rejected=spawnSync(process.execPath,[installedCli,'spaces','list'],
      {cwd:temp,env:cliEnv,encoding:'utf8'});
    if (rejected.status!==1 || JSON.parse(rejected.stderr).error.code!=='INSECURE_CONFIGURATION' ||
        (rejected.stdout+rejected.stderr).includes('generic-consumer-token'))
      throw new Error('Installed CLI accepted a token readable by another Windows principal');
    const powershell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const script=join(temp,'node_modules','@stateplane','cli','bin','secure-acl.ps1');
    const restored=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',script,'-TargetPath',tokenFile,'-Action','harden'],{cwd:temp,encoding:'utf8'});
    if (restored.status!==0) throw new Error(`Windows ACL restoration failed: ${restored.stderr}`);
    const logout=spawnSync(process.execPath,[installedCli,'auth','logout'],{cwd:temp,env:cliEnv,encoding:'utf8'});
    if (logout.status!==0 || existsSync(tokenFile)) throw new Error('Installed CLI failed to remove the Windows token');
  }
  await writeFile(join(temp, 'consumer.ts'), `import { parseRevision, type RecordRef, type Revision, type CollectionId, type SpaceId } from '@stateplane/contracts';
import type { HttpDependencies } from '@stateplane/api';
import type { StateplaneHttpClient } from '@stateplane/cli';
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
declare const cli: StateplaneHttpClient;
void tx; void receipt; void unsafe; void ref; void deps; void revision; void invalid; void cli;
`);
  await writeFile(join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, skipLibCheck: true, noEmit: true }, files: ['consumer.ts'] }));
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], temp);
  console.log('Packed Stateplane packages import and typecheck in an isolated npm consumer');
} finally {
  await rm(temp, { recursive: true, force: true });
}
