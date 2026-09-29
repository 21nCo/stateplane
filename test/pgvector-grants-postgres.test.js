import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsRoleSql } from '../scripts/topology-sql.mjs';
import { qualificationGrantsAllowed, qualificationGrantsSql } from '../deployment/workers/role-grants.js';
import { Client } from 'pg';
import { cleanupCluster } from './postgres-cluster-cleanup.mjs';

const run = promisify(execFile);
let postgresBin;
try {
  const version = execFileSync('pg_config', ['--version'], { encoding: 'utf8' });
  if (/PostgreSQL 1[6-9]\./.test(version)) {
    const bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    const shared = execFileSync('pg_config', ['--sharedir'], { encoding: 'utf8' }).trim();
    await Promise.all([...['initdb', 'pg_ctl', 'psql'].map(command =>
      access(join(bin, command), constants.X_OK)),
    access(join(shared, 'extension', 'vector.control'), constants.R_OK)]);
    postgresBin = bin;
  }
} catch { /* Local PostgreSQL is optional for the portable contract suite. */ }

test('documented role-specific pgvector grants exclude the settings login',
  { skip: !postgresBin || process.platform === 'win32', timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-vector-grants-'));
    const data = join(directory, 'db');
    let started = false;
    let primaryError;
    try {
      await run(join(postgresBin, 'initdb'), ['-D', data, '--auth-local=trust', '--auth-host=trust']);
      await run(join(postgresBin, 'pg_ctl'), ['-D', data, '-o',
        `-k ${directory} -c listen_addresses='' -p 5433`, '-l', join(directory, 'log'), 'start']);
      started = true;
      const psql = async (sql, variables = []) => {
        const script = join(directory, 'commands.sql');
        await writeFile(script, sql);
        return run(join(postgresBin, 'psql'),
          ['-X', '-h', directory, '-p', '5433', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
            ...variables.flatMap(([key, value]) => ['-v', `${key}=${value}`]), '-f', script]);
      };
      await psql(`CREATE EXTENSION vector;
        CREATE ROLE operational LOGIN;
        CREATE ROLE sta4_probe LOGIN;
        CREATE ROLE settings_reader LOGIN;
        GRANT pg_read_all_settings TO settings_reader;
        GRANT CREATE ON SCHEMA public TO sta4_probe;`);

      // The old runbook granted back only to operational; the disposable query was denied.
      await psql(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION public.l2_distance(public.vector, public.vector) TO operational;`);
      const distance = "SELECT '[1,0,0]'::vector <-> '[0,1,0]'::vector AS distance";
      await assert.rejects(psql(`SET ROLE sta4_probe; ${distance}`), /permission denied for function l2_distance/);

      const runbook = await readFile(new URL('../docs/regional-topology.md', import.meta.url), 'utf8');
      const documented = runbook.match(/<!-- pgvector-role-grants -->\s*```sql\n([^`]+)```/)?.[1];
      assert.ok(documented, 'the executable per-cell grant sequence must remain in the runbook');
      await psql(documented, [['target_role', 'operational']]);
      await assert.rejects(psql(`SET ROLE sta4_probe; ${distance}`), /permission denied for function l2_distance/,
        'operational databases must not grant a separately provisioned probe role');
      await psql('REVOKE EXECUTE ON FUNCTION public.l2_distance(public.vector, public.vector) FROM operational');
      await psql(documented, [['target_role', 'sta4_probe']]);
      await assert.rejects(psql(`SET ROLE operational; ${distance}`), /permission denied for function l2_distance/);
      assert.match((await psql(`SET ROLE sta4_probe; ${distance}`)).stdout, /1\.4142135623730951/);
      const { stdout: settings } = await psql(`SET ROLE settings_reader;
        SELECT has_function_privilege(current_user,
          'public.l2_distance(public.vector, public.vector)', 'EXECUTE') AS can_execute`);
      assert.match(settings, /\bf\b/);
      await assert.rejects(psql(`SET ROLE settings_reader; ${distance}`), /permission denied for function l2_distance/);
      const client = new Client({ host: directory, port: 5433, database: 'postgres' });
      await client.connect();
      try {
        await client.query('SET ROLE settings_reader');
        const settingsRow = (await client.query(settingsRoleSql)).rows[0];
        assert.equal(settingsRow.can_execute_routines, false, 'all user-schema functions and procedures are revoked');
        await client.query('RESET ROLE');
        await client.query('SET ROLE sta4_probe');
        assert.equal(qualificationGrantsAllowed((await client.query(qualificationGrantsSql)).rows[0]), true);
      } finally { await client.end(); }

      await psql('REVOKE EXECUTE ON FUNCTION public.l2_distance(public.vector, public.vector) FROM sta4_probe');
      await assert.rejects(psql(`SET ROLE sta4_probe; ${distance}`), /permission denied for function l2_distance/);
      await psql(documented, [['target_role', 'sta4_probe']]);
      assert.match((await psql(`SET ROLE sta4_probe; ${distance}`)).stdout, /1\.4142135623730951/,
        'retry or restore must reapply and verify the disposable grant');
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await cleanupCluster(
        () => started ? run(join(postgresBin, 'pg_ctl'), ['-D', data, 'stop', '-m', 'immediate']) : undefined,
        () => rm(directory, { recursive: true, force: true }), primaryError);
    }
  });
