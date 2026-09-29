import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import worker from '../deployment/workers/qualification';

const run = promisify(execFile);
let postgresBin: string | undefined;
try {
  if (/PostgreSQL 1[6-9]\./.test(execFileSync('pg_config', ['--version'], { encoding: 'utf8' }))) {
    const bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    const shared = execFileSync('pg_config', ['--sharedir'], { encoding: 'utf8' }).trim();
    await Promise.all([...['initdb', 'pg_ctl', 'psql'].map(command => access(join(bin, command), constants.X_OK)),
      access(join(shared, 'extension', 'vector.control'), constants.R_OK)]);
    postgresBin = bin;
  }
} catch { /* Portable CI may lack a local pgvector installation. */ }

it.skipIf(!postgresBin || process.platform === 'win32')('fences complete Worker probes in five real PostgreSQL disposable cells',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-worker-pg-'));
    const data = join(directory, 'db');
    const script = join(directory, 'commands.sql');
    let started = false;
    try {
      await run(join(postgresBin!, 'initdb'), ['-D', data, '--auth-local=trust', '--auth-host=trust']);
      await run(join(postgresBin!, 'pg_ctl'), ['-D', data, '-o',
        `-k ${directory} -c listen_addresses='' -p 5435`, '-l', join(directory, 'log'), 'start']);
      started = true;
      const psql = async (database: string, sql: string, role?: string) => {
        await writeFile(script, sql);
        await run(join(postgresBin!, 'psql'), ['-X', '-h', directory, '-p', '5435', '-d', database,
          '-v', 'ON_ERROR_STOP=1', ...(role ? ['-v', `target_role=${role}`] : []), '-f', script]);
      };
      const role = 'sta4_probe_aaaaaaaaaaaaaaaa';
      await psql('postgres', `CREATE ROLE ${role} LOGIN;`);
      const runbook = await readFile(new URL('../docs/regional-topology.md', import.meta.url), 'utf8');
      const recipe = runbook.match(/<!-- pgvector-role-grants -->\s*```sql\n([^`]+)```/)?.[1];
      expect(recipe).toBeTruthy();
      for (const suffix of ['dev_ap_southeast', 'dev_us_east', 'dev_eu_west', 'prod_ap_southeast', 'prod_us_east']) {
        const database = `sta4_aaaaaaaaaaaaaaaa_${suffix}`;
        await psql('postgres', `CREATE DATABASE ${database};`);
        await psql(database, `CREATE EXTENSION vector; GRANT CREATE ON SCHEMA public TO ${role};`);
        await psql(database, recipe!, role);
        const env = {
          AUTHORITY: { connectionString: `postgres://${role}@localhost/${database}?host=${encodeURIComponent(directory)}&port=5435` },
          PROBE_TOKEN: 'disposable-token', STATEPLANE_DISPOSABLE: '1',
          STATEPLANE_PROBE_DATABASE: database, STATEPLANE_PROBE_ROLE: role
        } as never;
        const call = (path: string, generation?: string) => worker.fetch(new Request(`https://preview.example${path}`, {
          method: 'POST', headers: { authorization: 'Bearer disposable-token',
            ...(generation ? { 'x-stateplane-attempt': generation } : {}) }
        }), env);
        const reserved = await call('/qualify/reserve');
        expect(reserved.status, `${suffix}: reserve`).toBe(200);
        const first = (await reserved.json() as { generation: string }).generation;
        expect(first).toBe('1');
        expect((await call('/qualify/start', first)).status, `${suffix}: start`).toBe(200);
        const probe = await call('/qualify', first);
        expect(probe.status, `${suffix}: probe`).toBe(200);
        expect(await probe.json()).toMatchObject({ rollback: true, freshRead: true });
        expect((await call('/qualify/residual', first)).status, `${suffix}: close`).toBe(200);
        const replay = await call('/qualify/reserve');
        expect(replay.status, `${suffix}: replay reservation`).toBe(200);
        const second = (await replay.json() as { generation: string }).generation;
        expect(second).toBe('2');
        expect((await call('/qualify/start', first)).status, `${suffix}: late old start`).toBe(500);
        expect((await call('/qualify/start', second)).status, `${suffix}: replay start`).toBe(200);
        expect((await call('/qualify', first)).status, `${suffix}: late old probe`).toBe(500);
        expect((await call('/qualify', second)).status, `${suffix}: replay probe`).toBe(200);
        expect((await call('/qualify/residual', second)).status, `${suffix}: replay close`).toBe(200);
      }
    } finally {
      if (started) await run(join(postgresBin!, 'pg_ctl'), ['-D', data, 'stop', '-m', 'immediate']);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
