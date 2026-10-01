import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { qualificationGrantsAllowed, qualificationGrantsSql, operationalGrantsAllowed, operationalGrantsSql } from '../deployment/workers/role-grants.js';
import { probeRelationAllowed, probeRelationsSql } from '../deployment/workers/probe-relations.js';
import { settingsRoleSql } from '../scripts/topology-sql.mjs';
import { cleanupCluster } from './postgres-cluster-cleanup.mjs';

const run = promisify(execFile);
let postgresBin;
try {
  const version = execFileSync('pg_config', ['--version'], { encoding: 'utf8' });
  if (/PostgreSQL 1[6-9]\./.test(version)) {
    const bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    const shared = execFileSync('pg_config', ['--sharedir'], { encoding: 'utf8' }).trim();
    await Promise.all([...['initdb', 'pg_ctl', 'psql'].map(command => access(join(bin, command), constants.X_OK)),
      access(join(shared, 'extension', 'vector.control'), constants.R_OK)]);
    postgresBin = bin;
  }
} catch { /* Real PostgreSQL is optional for portable CI. */ }

test('real PostgreSQL isolates control, cells and separate disposable databases before DDL',
  { skip: !postgresBin || process.platform === 'win32', timeout: 60_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-privileges-'));
    const data = join(directory, 'db');
    let started = false;
    let primaryError;
    try {
      await run(join(postgresBin, 'initdb'), ['-D', data, '--auth-local=trust', '--auth-host=trust']);
      await run(join(postgresBin, 'pg_ctl'), ['-D', data, '-o',
        `-k ${directory} -c listen_addresses='' -p 5434`, '-l', join(directory, 'log'), 'start']);
      started = true;
      const topology = JSON.parse(await readFile(new URL('../deployment/topology.json', import.meta.url), 'utf8'));
      const resources = Object.entries(topology.environments).flatMap(([environmentName, environment]) =>
        [{ name: `${environmentName}/control`, control: true },
          ...environment.cells.map(cell => ({ name: `${environmentName}/${cell.id}`, control: false }))]);
      assert.equal(resources.length, 7, 'both controls and all five cells are covered');
      const runbook = await readFile(new URL('../docs/regional-topology.md', import.meta.url), 'utf8');
      const recipe = runbook.match(/<!-- pgvector-role-grants -->\s*```sql\n([^`]+)```/)?.[1];
      assert.ok(recipe, 'the executable role recipe must be documented');
      const script = join(directory, 'grant.sql');
      const psql = async (database, sql, role) => {
        await writeFile(script, sql);
        return run(join(postgresBin, 'psql'), ['-X', '-h', directory, '-p', '5434', '-d', database,
          '-v', 'ON_ERROR_STOP=1', ...(role ? ['-v', `target_role=${role}`] : []), '-f', script]);
      };
      const withRole = async (database, role, sql, all = false) => {
        const client = new Client({ host: directory, port: 5434, database });
        await client.connect();
        try {
          await client.query(`SET ROLE ${role}`);
          const rows = (await client.query(sql)).rows;
          return all ? rows : rows[0];
        } finally { await client.end(); }
      };
      const relationRows = (database, role) => withRole(database, role,
        `SELECT current_user AS current_role, probe.* FROM (${probeRelationsSql}) AS probe`, true);
      await psql('postgres', 'CREATE ROLE settings_reader LOGIN; GRANT pg_read_all_settings TO settings_reader;');
      for (let index = 0; index < resources.length; index++) {
        const operationalDb = `sta4_operational_${index}`;
        const operationalRole = `sta4_operational_${index}`;
        await psql('postgres', `CREATE ROLE ${operationalRole} LOGIN; CREATE DATABASE ${operationalDb};`);
        await psql(operationalDb, 'CREATE EXTENSION vector;');
        await psql(operationalDb, recipe, operationalRole);
        assert.equal(operationalGrantsAllowed(await withRole(operationalDb, operationalRole, operationalGrantsSql)), true,
          `${resources[index].name} operational admission`);
        assert.equal((await withRole(operationalDb, 'settings_reader', settingsRoleSql)).can_execute_routines, false,
          `${resources[index].name} settings credential`);
        if (resources[index].control) continue; // Only cells have disposable qualification targets.
        const disposableDb = `sta4_disposable_${index}`;
        const probeRole = `sta4_probe_${index}`;
        await psql('postgres', `CREATE ROLE ${probeRole} LOGIN; CREATE DATABASE ${disposableDb};`);
        await psql(disposableDb, `CREATE EXTENSION vector; GRANT CREATE ON SCHEMA public TO ${probeRole};`);
        await psql(disposableDb, recipe, probeRole);
        assert.equal(qualificationGrantsAllowed(await withRole(disposableDb, probeRole, qualificationGrantsSql)), true,
          `${resources[index].name} disposable admission`);
        await psql(disposableDb, `SET ROLE ${probeRole};
          CREATE TABLE public.stateplane_qualification (probe_id uuid PRIMARY KEY, value integer NOT NULL);
          CREATE TABLE public.stateplane_qualification_attempt
            (singleton boolean PRIMARY KEY CHECK (singleton), generation bigint NOT NULL, active boolean NOT NULL);
          RESET ROLE;`);
        assert.equal((await relationRows(disposableDb, probeRole)).every(probeRelationAllowed), true,
          `${resources[index].name} probe relations have exact owned base-table shape`);
        assert.equal((await withRole(disposableDb, 'settings_reader', settingsRoleSql)).can_execute_routines, false,
          `${resources[index].name} disposable settings credential`);
        assert.equal((await withRole(operationalDb, probeRole,
          "SELECT has_function_privilege(current_user, 'public.l2_distance(public.vector,public.vector)', 'EXECUTE') AS allowed")).allowed,
        false, 'a separately created probe role is not granted in an operational database');
      }

      const db = 'sta4_disposable_1';
      const probe = 'sta4_probe_1';
      await psql(db, `DROP TABLE public.stateplane_qualification;
        CREATE TABLE hidden_business (probe_id uuid PRIMARY KEY, value integer NOT NULL);
        CREATE VIEW public.stateplane_qualification AS SELECT probe_id, value FROM hidden_business;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.stateplane_qualification TO ${probe};`);
      assert.equal(qualificationGrantsAllowed(await withRole(db, probe, qualificationGrantsSql)), true,
        'the old grant-only admission accepts a same-name updatable view');
      assert.equal((await relationRows(db, probe)).every(probeRelationAllowed), false,
        'catalog admission rejects the view before probe writes hidden data');
      assert.equal((await withRole(db, probe, 'SELECT count(*)::integer AS count FROM public.stateplane_qualification')).count, 0);
      await psql(db, `DROP VIEW public.stateplane_qualification;
        CREATE TABLE public.stateplane_qualification (probe_id uuid PRIMARY KEY, value integer NOT NULL);
        ALTER TABLE public.stateplane_qualification OWNER TO ${probe};`);
      assert.equal((await relationRows(db, probe)).every(probeRelationAllowed), true);
      await psql(db, 'ALTER TABLE public.stateplane_qualification ADD COLUMN extra text;');
      assert.equal((await relationRows(db, probe)).every(probeRelationAllowed), false, 'wrong shape is rejected');
      await psql(db, 'ALTER TABLE public.stateplane_qualification DROP COLUMN extra;');
      await psql(db, 'ALTER TABLE public.stateplane_qualification OWNER TO CURRENT_USER;');
      assert.equal((await relationRows(db, probe)).every(probeRelationAllowed), false, 'foreign owner is rejected');
      await psql(db, `ALTER TABLE public.stateplane_qualification OWNER TO ${probe};
        CREATE SCHEMA other_probe;
        CREATE TABLE other_probe.stateplane_qualification (probe_id uuid PRIMARY KEY, value integer NOT NULL);`);
      assert.equal((await relationRows(db, probe)).every(probeRelationAllowed), false,
        'same-name relation in another schema is rejected');
      await psql(db, 'DROP SCHEMA other_probe CASCADE;');
      assert.equal((await relationRows(db, probe)).every(probeRelationAllowed), true, 'clean replay relations pass');
      const flags = () => withRole(db, probe, qualificationGrantsSql);
      const admitted = async () => qualificationGrantsAllowed(await flags());
      await psql(db, `CREATE TABLE private_records(secret text);
        INSERT INTO private_records VALUES ('private-value');
        CREATE PROCEDURE public.expose_private() LANGUAGE sql SECURITY DEFINER
          AS 'INSERT INTO private_records VALUES (''called'')';`);
      assert.equal((await flags()).no_other_routine_execute, false, 'PUBLIC procedure EXECUTE is visible');
      assert.equal((await withRole(db, 'settings_reader', settingsRoleSql)).can_execute_routines, true,
        'a new default-PUBLIC procedure invalidates PGDATA proof');
      await psql(db, 'REVOKE EXECUTE ON PROCEDURE public.expose_private() FROM PUBLIC;');
      assert.equal(await admitted(), true, 'revoking PUBLIC procedure EXECUTE restores admission');

      await psql(db, 'GRANT EXECUTE ON PROCEDURE public.expose_private() TO sta4_probe_1;');
      assert.equal((await flags()).no_other_routine_execute, false, 'direct procedure grant is denied');
      await psql(db, 'REVOKE EXECUTE ON PROCEDURE public.expose_private() FROM sta4_probe_1;');
      assert.equal(await admitted(), true);
      await psql(db, 'CREATE SEQUENCE private_seq; GRANT USAGE ON SEQUENCE private_seq TO sta4_probe_1;');
      assert.equal((await flags()).no_sequence_access, false, 'direct sequence access is denied');
      assert.equal((await withRole(db, probe, "SELECT nextval('private_seq') AS value")).value, '1',
        'the denied privilege can mutate real state');
      await psql(db, 'REVOKE USAGE ON SEQUENCE private_seq FROM sta4_probe_1; GRANT USAGE ON SEQUENCE private_seq TO PUBLIC;');
      assert.equal((await flags()).no_sequence_access, false, 'PUBLIC sequence grant is denied');
      await psql(db, 'REVOKE USAGE ON SEQUENCE private_seq FROM PUBLIC;');
      assert.equal(await admitted(), true);

      await psql(db, `CREATE ROLE privilege_parent; GRANT EXECUTE ON PROCEDURE public.expose_private() TO privilege_parent;
        GRANT privilege_parent TO ${probe} WITH INHERIT TRUE, SET FALSE;`);
      assert.equal((await flags()).no_other_routine_execute, false, 'inherited routine grant is denied');
      await psql(db, `REVOKE privilege_parent FROM ${probe};`);
      assert.equal(await admitted(), true);
      await psql(db, `SET ROLE ${probe}; CREATE SEQUENCE public.owned_seq; RESET ROLE;
        REVOKE USAGE ON SEQUENCE public.owned_seq FROM PUBLIC;`);
      assert.equal((await flags()).no_sequence_access, false, 'sequence ownership is denied');
      await psql(db, 'DROP SEQUENCE public.owned_seq;');
      await psql(db, `SET ROLE ${probe}; CREATE FUNCTION public.owned_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'; RESET ROLE;
        REVOKE EXECUTE ON FUNCTION public.owned_fn() FROM PUBLIC;`);
      assert.equal((await flags()).no_other_routine_execute, false, 'routine ownership is denied');
      await psql(db, 'DROP FUNCTION public.owned_fn();');
      assert.equal(await admitted(), true);
      await psql(db, `REVOKE EXECUTE ON FUNCTION public.l2_distance(public.vector,public.vector) FROM ${probe};`);
      assert.equal((await flags()).can_execute_distance, false, 'missing distance grant fails before vector query');
      assert.equal(await admitted(), false);
      await psql(db, recipe, probe);
      assert.equal(await admitted(), true, 'retry or restore reapplication reopens only the approved grant');
      await psql(db, `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON ROUTINES FROM PUBLIC;
        CREATE FUNCTION public.future_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';`);
      assert.equal((await withRole(db, 'settings_reader', settingsRoleSql)).can_execute_routines, false,
        'global default privilege revoke protects a future creator');
      assert.equal(await admitted(), true);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await cleanupCluster(
        () => started ? run(join(postgresBin, 'pg_ctl'), ['-D', data, 'stop', '-m', 'immediate']) : undefined,
        () => rm(directory, { recursive: true, force: true }), primaryError);
    }
  });
