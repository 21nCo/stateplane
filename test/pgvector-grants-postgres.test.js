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
import { Client, Pool } from 'pg';
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
        await client.query('CREATE TABLE stateplane_qualification (probe_id uuid PRIMARY KEY, value integer NOT NULL)');
        await client.query('CREATE TABLE stateplane_qualification_attempt (singleton boolean PRIMARY KEY CHECK (singleton), generation bigint NOT NULL, active boolean NOT NULL)');
        assert.equal(qualificationGrantsAllowed((await client.query(qualificationGrantsSql)).rows[0]), true,
          'the two disposable fence tables remain admissible on replay');
        await client.query('CREATE TABLE unexpected_probe_data (value integer)');
        assert.equal(qualificationGrantsAllowed((await client.query(qualificationGrantsSql)).rows[0]), false,
          'the fence exception does not admit unrelated owned tables');
        await client.query('DROP TABLE unexpected_probe_data');
        const attempt = '1';
        await client.query('INSERT INTO stateplane_qualification_attempt (singleton, generation, active) VALUES (TRUE, $1, TRUE)', [attempt]);
        const shared = new Client({ host: directory, port: 5433, database: 'postgres' });
        const closer = new Client({ host: directory, port: 5433, database: 'postgres' });
        await Promise.all([shared.connect(), closer.connect()]);
        try {
          await Promise.all([shared.query('SET ROLE sta4_probe'), closer.query('SET ROLE sta4_probe')]);
          await shared.query('BEGIN');
          await shared.query('SELECT generation FROM stateplane_qualification_attempt WHERE singleton = TRUE FOR SHARE');
          await closer.query('BEGIN');
          await closer.query("SET LOCAL lock_timeout = '2000ms'");
          let exclusiveAcquired = false;
          const exclusive = closer.query('SELECT generation FROM stateplane_qualification_attempt WHERE singleton = TRUE FOR UPDATE')
            .then(value => { exclusiveAcquired = true; return value; });
          await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
          assert.equal(exclusiveAcquired, false, 'close must wait for an admitted Worker transaction');
          await shared.query('ROLLBACK');
          assert.equal((await exclusive).rows[0].generation, attempt);
          await closer.query('UPDATE stateplane_qualification_attempt SET active = FALSE WHERE singleton = TRUE');
          await closer.query('COMMIT');
          assert.equal((await client.query('SELECT active FROM stateplane_qualification_attempt')).rows[0].active, false);
          const replay = await client.query(`UPDATE stateplane_qualification_attempt
            SET generation = generation + 1, active = TRUE WHERE singleton = TRUE RETURNING generation`);
          assert.equal(replay.rows[0].generation, '2');
          await client.query('UPDATE stateplane_qualification_attempt SET active = FALSE WHERE singleton = TRUE');
          const delayedOldStart = await client.query(`UPDATE stateplane_qualification_attempt SET active = TRUE
            WHERE singleton = TRUE AND generation = $1 AND active = FALSE RETURNING generation`, ['1']);
          assert.equal(delayedOldStart.rowCount, 0, 'older independent start cannot reopen after newer close');
        } finally {
          await Promise.allSettled([shared.query('ROLLBACK'), closer.query('ROLLBACK')]);
          await Promise.allSettled([shared.end(), closer.end()]);
        }
        const pool = new Pool({ host: directory, port: 5433, database: 'postgres', user: 'sta4_probe',
          max: 5, connectionTimeoutMillis: 500 });
        let borrowed = 0;
        let peakBorrowed = 0;
        const boundedProbe = async () => {
          const reader = await pool.connect();
          borrowed++;
          peakBorrowed = Math.max(peakBorrowed, borrowed);
          try {
            await reader.query('BEGIN');
            await reader.query('SELECT generation FROM stateplane_qualification_attempt WHERE singleton = TRUE FOR SHARE');
            const writer = await pool.connect();
            borrowed++;
            peakBorrowed = Math.max(peakBorrowed, borrowed);
            try { await writer.query('SELECT 1'); }
            finally { borrowed--; writer.release(); }
          } finally {
            await reader.query('ROLLBACK');
            borrowed--;
            reader.release();
          }
        };
        try {
          for (let batch = 0; batch < 5; batch++) await Promise.all([boundedProbe(), boundedProbe()]);
          assert.ok(peakBorrowed <= 4, 'ten probes in pairs keep one of five origin slots free');
          assert.equal(borrowed, 0);
        } finally { await pool.end(); }
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
