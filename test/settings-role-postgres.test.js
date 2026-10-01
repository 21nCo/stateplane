import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { settingsRoleSql } from '../scripts/topology-sql.mjs';
import { cleanupCluster } from './postgres-cluster-cleanup.mjs';

const run = promisify(execFile);

test('cluster directory is removed after stop failure without masking the original failure', async () => {
  const primary = new Error('probe failed');
  let removed = false;
  await cleanupCluster(async () => { throw new Error('stop failed'); }, async () => { removed = true; }, primary);
  assert.equal(removed, true);
  await assert.rejects(cleanupCluster(async () => { throw new Error('stop failed'); }, async () => {}, null),
    /stop failed/);
});
let postgresBin;
try {
  const version = execFileSync('pg_config', ['--version'], { encoding: 'utf8' });
  if (/PostgreSQL 1[6-9]\./.test(version)) {
    const bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    await Promise.all([access(join(bin, 'initdb'), constants.X_OK), access(join(bin, 'pg_ctl'), constants.X_OK)]);
    postgresBin = bin;
  }
} catch { /* The hermetic suite also runs without local PostgreSQL. */ }

test('real PostgreSQL settings proof rejects transitive roles, relation and routine access',
  { skip: !postgresBin || process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-settings-role-'));
    const data = join(directory, 'db');
    let started = false;
    let primaryError;
    try {
      await run(join(postgresBin, 'initdb'), ['-D', data, '--auth-local=trust', '--auth-host=trust']);
      await run(join(postgresBin, 'pg_ctl'), ['-D', data,
        '-o', `-k ${directory} -c listen_addresses='' -p 5432`, '-l', join(directory, 'log'), 'start']);
      started = true;
      const client = new Client({ host: directory, database: 'postgres' });
      await client.connect();
      try {
        await client.query(`CREATE ROLE settings_reader LOGIN;
          GRANT pg_read_all_settings TO settings_reader;
          CREATE ROLE elevated NOLOGIN;
          CREATE TABLE private_records(id integer, secret text);`);
        await client.query('REVOKE TEMP ON DATABASE postgres FROM PUBLIC');
        const flags = async () => {
          await client.query('SET ROLE settings_reader');
          try { return (await client.query(settingsRoleSql)).rows[0]; }
          finally { await client.query('RESET ROLE'); }
        };
        const allowed = row => row.can_read_settings && row.only_settings_membership &&
          !row.can_access_tables && !row.can_access_sequences && !row.can_execute_routines &&
          !row.can_access_large_objects && !row.can_create_database && !row.can_create_temp &&
          !row.can_create_schema && !row.can_execute_restricted_routines &&
          !row.owns_user_objects && row.no_parameter_admin;
        assert.equal(allowed(await flags()), true, 'direct settings membership is sufficient');

        await client.query('GRANT EXECUTE ON FUNCTION pg_catalog.abs(integer) TO elevated');
        assert.equal((await flags()).can_execute_restricted_routines, false,
          'an unrelated grant does not change default PUBLIC builtin execution');
        await client.query('REVOKE EXECUTE ON FUNCTION pg_catalog.abs(integer) FROM elevated');
        assert.equal(allowed(await flags()), true,
          'a materialized builtin ACL after revocation retains least-privilege admission');

        await client.query(`INSERT INTO private_records VALUES (1, 'private-fixture');
          CREATE FUNCTION pg_catalog.read_private_fixture() RETURNS text LANGUAGE sql SECURITY DEFINER
            AS 'SELECT secret FROM public.private_records LIMIT 1';
          CREATE FUNCTION pg_catalog.write_private_fixture() RETURNS text LANGUAGE sql SECURITY DEFINER
            AS 'UPDATE public.private_records SET secret = ''modified'' RETURNING secret';`);
        for (const name of ['read_private_fixture', 'write_private_fixture']) {
          const provenance = (await client.query(`SELECT p.oid >= 16384::oid AS created_after_initdb,
              initial.objoid IS NOT NULL AS has_initial_privileges
            FROM pg_proc p LEFT JOIN pg_init_privs initial ON initial.classoid = 'pg_proc'::regclass
              AND initial.objoid = p.oid AND initial.objsubid = 0
            WHERE p.oid = $1::regprocedure`, [`pg_catalog.${name}()`])).rows[0];
          assert.deepEqual(provenance, { created_after_initdb: true, has_initial_privileges: false });
          assert.equal((await flags()).can_execute_restricted_routines, true,
            `post-initdb ${name} with default PUBLIC EXECUTE is denied`);
          await client.query('SET SESSION AUTHORIZATION settings_reader');
          try {
            const result = await client.query(`SELECT pg_catalog.${name}() AS value`);
            assert.equal(result.rows[0].value, name === 'read_private_fixture' ? 'private-fixture' : 'modified');
          } finally { await client.query('RESET SESSION AUTHORIZATION'); }
          await client.query(`REVOKE EXECUTE ON FUNCTION pg_catalog.${name}() FROM PUBLIC`);
          assert.equal(allowed(await flags()), name === 'write_private_fixture',
            `revoking ${name} removes its effective execution`);
        }
        await client.query('DROP FUNCTION pg_catalog.write_private_fixture()');
        assert.equal(allowed(await flags()), true, 'revoking both catalog routines restores admission');
        await client.query('GRANT EXECUTE ON FUNCTION pg_catalog.read_private_fixture() TO settings_reader');
        assert.equal((await flags()).can_execute_restricted_routines, true,
          'direct EXECUTE on later catalog routine is denied');
        await client.query('REVOKE EXECUTE ON FUNCTION pg_catalog.read_private_fixture() FROM settings_reader');
        assert.equal(allowed(await flags()), true, 'revoking direct EXECUTE restores admission');
        await client.query('DROP FUNCTION pg_catalog.read_private_fixture()');
        await client.query('DELETE FROM private_records');

        await client.query('GRANT CREATE ON SCHEMA pg_catalog TO settings_reader');
        assert.equal((await flags()).can_create_schema, true,
          'catalog CREATE is denied before a settings login can add a routine');
        await client.query('REVOKE CREATE ON SCHEMA pg_catalog FROM settings_reader');
        assert.equal(allowed(await flags()), true,
          'revoking catalog CREATE restores admission');

        for (const grantee of ['settings_reader', 'elevated', 'PUBLIC']) {
          if (grantee === 'elevated') await client.query('GRANT elevated TO settings_reader WITH INHERIT TRUE, SET FALSE');
          await client.query(`GRANT TEMP ON DATABASE postgres TO ${grantee}`);
          assert.equal((await flags()).can_create_temp, true, `${grantee} TEMP is denied`);
          await client.query('SET SESSION AUTHORIZATION settings_reader');
          try {
            await client.query('CREATE TEMP TABLE admitted_temp(value text)');
            await client.query('DROP TABLE admitted_temp');
          }
          finally { await client.query('RESET SESSION AUTHORIZATION'); }
          await client.query(`REVOKE TEMP ON DATABASE postgres FROM ${grantee}`);
          if (grantee === 'elevated') await client.query('REVOKE elevated FROM settings_reader');
          assert.equal(allowed(await flags()), true, `${grantee} TEMP revocation restores admission`);
        }

        for (const grantee of ['settings_reader', 'elevated', 'PUBLIC']) {
          if (grantee === 'elevated') await client.query('GRANT elevated TO settings_reader WITH INHERIT TRUE, SET FALSE');
          await client.query(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO ${grantee}`);
          assert.equal((await flags()).can_execute_restricted_routines, true,
            `${grantee} restricted pg_catalog EXECUTE is denied`);
          await client.query('SET SESSION AUTHORIZATION settings_reader');
          try {
            const result = await client.query("SELECT length(pg_catalog.pg_read_file('PG_VERSION')) AS bytes");
            assert.ok(result.rows[0].bytes > 0);
          } finally { await client.query('RESET SESSION AUTHORIZATION'); }
          await client.query(`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM ${grantee}`);
          if (grantee === 'elevated') await client.query('REVOKE elevated FROM settings_reader');
          assert.equal(allowed(await flags()), true, `${grantee} restricted EXECUTE revocation restores admission`);
        }

        await client.query('GRANT elevated TO pg_read_all_settings WITH INHERIT FALSE, SET TRUE');
        assert.equal((await flags()).only_settings_membership, false,
          'an alternate role reachable through the approved role must be rejected');
        await client.query('SET SESSION AUTHORIZATION settings_reader');
        try {
          assert.equal((await client.query('SELECT session_user AS role')).rows[0].role, 'settings_reader');
          await client.query('SET ROLE elevated');
          assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, 'elevated');
        } finally { await client.query('RESET SESSION AUTHORIZATION'); }
        await client.query('REVOKE elevated FROM pg_read_all_settings');

        await client.query('GRANT SELECT(secret) ON private_records TO settings_reader');
        assert.equal((await flags()).can_access_tables, true, 'column SELECT is application access');
        await client.query('REVOKE SELECT(secret) ON private_records FROM settings_reader');
        await client.query('GRANT UPDATE(secret) ON private_records TO settings_reader');
        assert.equal((await flags()).can_access_tables, true, 'column UPDATE is application access');
        await client.query('REVOKE UPDATE(secret) ON private_records FROM settings_reader');

        await client.query('GRANT CREATE ON SCHEMA public TO settings_reader');
        assert.equal((await flags()).can_create_schema, true, 'schema CREATE is denied');
        await client.query('SET ROLE settings_reader');
        await client.query('CREATE TABLE owned_records(id integer)');
        await client.query('RESET ROLE');
        await client.query('REVOKE CREATE ON SCHEMA public FROM settings_reader');
        assert.equal((await flags()).can_access_tables, true, 'table ownership remains denied after CREATE is revoked');
        await client.query('DROP TABLE owned_records');

        await client.query('CREATE SEQUENCE private_seq');
        for (const privilege of ['USAGE', 'SELECT', 'UPDATE']) {
          await client.query(`GRANT ${privilege} ON SEQUENCE private_seq TO settings_reader`);
          assert.equal((await flags()).can_access_sequences, true,
            `direct sequence ${privilege} is application access`);
          if (privilege === 'USAGE') {
            await client.query('SET SESSION AUTHORIZATION settings_reader');
            try { assert.equal((await client.query('SELECT nextval(\'private_seq\') AS value')).rows[0].value, '1'); }
            finally { await client.query('RESET SESSION AUTHORIZATION'); }
          }
          await client.query(`REVOKE ${privilege} ON SEQUENCE private_seq FROM settings_reader`);
          assert.equal(allowed(await flags()), true, 'revoking sequence access restores admission');
        }
        await client.query('GRANT USAGE ON SEQUENCE private_seq TO PUBLIC');
        assert.equal((await flags()).can_access_sequences, true, 'PUBLIC sequence access is denied');
        await client.query('REVOKE USAGE ON SEQUENCE private_seq FROM PUBLIC');

        await client.query('GRANT CREATE ON SCHEMA public TO settings_reader');
        await client.query('SET ROLE settings_reader');
        await client.query('CREATE SEQUENCE owned_seq');
        await client.query('RESET ROLE');
        await client.query('REVOKE CREATE ON SCHEMA public FROM settings_reader');
        assert.equal((await flags()).can_access_sequences, true,
          'sequence ownership remains denied after CREATE is revoked');
        await client.query('DROP SEQUENCE owned_seq');

        await client.query('GRANT USAGE ON SEQUENCE private_seq TO elevated');
        await client.query('GRANT elevated TO settings_reader WITH INHERIT TRUE, SET FALSE');
        assert.equal((await flags()).can_access_sequences, true, 'inherited sequence access is denied');
        await client.query('REVOKE elevated FROM settings_reader');
        await client.query('REVOKE USAGE ON SEQUENCE private_seq FROM elevated');
        assert.equal(allowed(await flags()), true, 'approved settings-only role remains admissible');
        await client.query('DROP SEQUENCE private_seq');

        const largeObject = Number((await client.query('SELECT lo_create(0) AS oid')).rows[0].oid);
        await client.query('SELECT lo_put($1, 0, convert_to($2, \'UTF8\'))',
          [largeObject, 'hidden-business-payload']);
        for (const privilege of ['SELECT', 'UPDATE']) {
          await client.query(`GRANT ${privilege} ON LARGE OBJECT ${largeObject} TO settings_reader`);
          assert.equal((await flags()).can_access_large_objects, true,
            `direct large-object ${privilege} is denied`);
          // lo_put opens the object for an update and PostgreSQL also requires SELECT for that call.
          if (privilege === 'UPDATE') await client.query(`GRANT SELECT ON LARGE OBJECT ${largeObject} TO settings_reader`);
          await client.query('SET SESSION AUTHORIZATION settings_reader');
          try {
            if (privilege === 'SELECT') {
              const result = await client.query('SELECT convert_from(lo_get($1), \'UTF8\') AS value', [largeObject]);
              assert.equal(result.rows[0].value, 'hidden-business-payload');
            } else {
              await client.query('SELECT lo_put($1, 0, convert_to($2, \'UTF8\'))',
                [largeObject, 'modified-business-payload']);
            }
          } finally { await client.query('RESET SESSION AUTHORIZATION'); }
          await client.query(`REVOKE SELECT, UPDATE ON LARGE OBJECT ${largeObject} FROM settings_reader`);
          assert.equal(allowed(await flags()), true, 'revoking large-object access restores admission');
        }
        for (const grantee of ['PUBLIC', 'elevated', 'pg_read_all_settings']) {
          for (const privilege of ['SELECT', 'UPDATE']) {
            await client.query(`GRANT ${privilege} ON LARGE OBJECT ${largeObject} TO ${grantee}`);
            if (grantee === 'elevated') await client.query('GRANT elevated TO settings_reader WITH INHERIT TRUE, SET FALSE');
            assert.equal((await flags()).can_access_large_objects, true,
              `${grantee} large-object ${privilege} is denied`);
            if (grantee === 'elevated') await client.query('REVOKE elevated FROM settings_reader');
            await client.query(`REVOKE ${privilege} ON LARGE OBJECT ${largeObject} FROM ${grantee}`);
            assert.equal(allowed(await flags()), true, 'revoking large-object access restores admission');
          }
        }
        await client.query('SET lo_compat_privileges = on');
        assert.equal((await flags()).can_access_large_objects, true,
          'large-object ACL compatibility mode cannot admit the settings login');
        await client.query('SET SESSION AUTHORIZATION settings_reader');
        try {
          const result = await client.query('SELECT convert_from(lo_get($1), \'UTF8\') AS value', [largeObject]);
          assert.equal(result.rows[0].value, 'modified-business-payload');
        } finally { await client.query('RESET SESSION AUTHORIZATION'); }
        await client.query('RESET lo_compat_privileges');
        assert.equal(allowed(await flags()), true, 'restoring large-object ACL enforcement restores admission');
        await client.query('SET ROLE settings_reader');
        const ownedLargeObject = Number((await client.query('SELECT lo_create(0) AS oid')).rows[0].oid);
        await client.query('RESET ROLE');
        assert.equal((await flags()).can_access_large_objects, true, 'large-object owner is denied');
        await client.query('SELECT lo_unlink($1)', [ownedLargeObject]);
        assert.equal(allowed(await flags()), true, 'removing owned large object restores admission');
        await client.query(`ALTER LARGE OBJECT ${largeObject} OWNER TO pg_read_all_settings`);
        assert.equal((await flags()).can_access_large_objects, true,
          'ownership through the approved inherited role exposes a large object');
        await client.query('SET SESSION AUTHORIZATION settings_reader');
        try {
          const result = await client.query('SELECT convert_from(lo_get($1), \'UTF8\') AS value', [largeObject]);
          assert.equal(result.rows[0].value, 'modified-business-payload');
        } finally { await client.query('RESET SESSION AUTHORIZATION'); }
        await client.query(`ALTER LARGE OBJECT ${largeObject} OWNER TO CURRENT_USER`);
        assert.equal(allowed(await flags()), true, 'transferring inherited ownership restores admission');

        for (const grantee of ['settings_reader', 'pg_read_all_settings', 'PUBLIC']) {
          await client.query(`GRANT SET ON PARAMETER lo_compat_privileges TO ${grantee}`);
          assert.equal((await flags()).no_parameter_admin, false, `${grantee} SET is denied`);
          if (grantee === 'settings_reader') {
            await client.query('SET SESSION AUTHORIZATION settings_reader');
            try {
              await client.query('SET lo_compat_privileges = on');
              const result = await client.query('SELECT convert_from(lo_get($1), \'UTF8\') AS value', [largeObject]);
              assert.equal(result.rows[0].value, 'modified-business-payload');
            } finally { await client.query('RESET SESSION AUTHORIZATION'); }
            await client.query('RESET lo_compat_privileges');
          }
          await client.query(`REVOKE SET ON PARAMETER lo_compat_privileges FROM ${grantee}`);
          assert.equal(allowed(await flags()), true, 'revocation restores settings admission');
        }
        await client.query('GRANT ALTER SYSTEM ON PARAMETER lo_compat_privileges TO settings_reader');
        assert.equal((await flags()).no_parameter_admin, false, 'ALTER SYSTEM is denied');
        await client.query('REVOKE ALTER SYSTEM ON PARAMETER lo_compat_privileges FROM settings_reader');
        assert.equal(allowed(await flags()), true);
        await client.query('SELECT lo_unlink($1)', [largeObject]);

        await client.query(`INSERT INTO private_records VALUES (1, 'private-value');
          CREATE FUNCTION public.expose_secret() RETURNS text LANGUAGE sql SECURITY DEFINER
            AS 'SELECT secret FROM private_records LIMIT 1';`);
        assert.equal((await flags()).can_execute_routines, true,
          'default PUBLIC EXECUTE on a SECURITY DEFINER function is denied');
        await client.query('SET SESSION AUTHORIZATION settings_reader');
        try {
          assert.equal((await client.query('SELECT public.expose_secret() AS secret')).rows[0].secret,
            'private-value', 'the rejected routine really exposes private data');
        } finally { await client.query('RESET SESSION AUTHORIZATION'); }
        await client.query('REVOKE EXECUTE ON FUNCTION public.expose_secret() FROM PUBLIC');
        assert.equal(allowed(await flags()), true, 'revoking default PUBLIC EXECUTE restores admission');

        await client.query('GRANT EXECUTE ON FUNCTION public.expose_secret() TO settings_reader');
        assert.equal((await flags()).can_execute_routines, true, 'direct routine EXECUTE is denied');
        await client.query('REVOKE EXECUTE ON FUNCTION public.expose_secret() FROM settings_reader');
        assert.equal(allowed(await flags()), true, 'revoking direct EXECUTE restores admission');

        await client.query('GRANT EXECUTE ON FUNCTION public.expose_secret() TO elevated');
        await client.query('GRANT elevated TO settings_reader WITH INHERIT TRUE, SET FALSE');
        assert.equal((await flags()).can_execute_routines, true, 'inherited routine EXECUTE is denied');
        await client.query('REVOKE elevated FROM settings_reader');
        await client.query('REVOKE EXECUTE ON FUNCTION public.expose_secret() FROM elevated');
        assert.equal(allowed(await flags()), true, 'revoking inherited EXECUTE restores admission');

        await client.query('GRANT CREATE ON SCHEMA public TO settings_reader');
        await client.query('SET ROLE settings_reader');
        await client.query("CREATE FUNCTION public.owned_routine() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
        await client.query('RESET ROLE');
        await client.query('REVOKE CREATE ON SCHEMA public FROM settings_reader');
        await client.query('REVOKE EXECUTE ON FUNCTION public.owned_routine() FROM PUBLIC');
        assert.equal((await flags()).can_execute_routines, true,
          'routine ownership remains executable after CREATE and PUBLIC grants are revoked');
        await client.query('DROP FUNCTION public.owned_routine()');

        const ownedObjects = [
          { create: "CREATE TYPE public.owned_status AS ENUM ('ready')", drop: 'DROP TYPE public.owned_status' },
          { create: 'CREATE DOMAIN public.owned_domain AS integer', drop: 'DROP DOMAIN public.owned_domain' },
          { create: "CREATE COLLATION public.owned_collation (provider = libc, locale = 'C')",
            drop: 'DROP COLLATION public.owned_collation' },
          { create: 'CREATE OPERATOR public.@@@ (PROCEDURE = pg_catalog.int4pl, LEFTARG = integer, RIGHTARG = integer)',
            drop: 'DROP OPERATOR public.@@@ (integer, integer)' }
        ];
        for (const object of ownedObjects) {
          await client.query('GRANT CREATE ON SCHEMA public TO settings_reader');
          await client.query('SET ROLE settings_reader');
          await client.query(object.create);
          await client.query('RESET ROLE');
          await client.query('REVOKE CREATE ON SCHEMA public FROM settings_reader');
          const row = await flags();
          assert.equal(row.owns_user_objects, true, `${object.create} ownership is denied`);
          assert.equal(allowed(row), false, 'the settings-only admission fails for an owner');
          await client.query('SET ROLE settings_reader');
          await client.query(object.drop);
          await client.query('RESET ROLE');
          assert.equal(allowed(await flags()), true, 'dropping the owned object restores admission');
        }
        await client.query("CREATE TYPE public.inherited_status AS ENUM ('ready')");
        await client.query('ALTER TYPE public.inherited_status OWNER TO pg_read_all_settings');
        assert.equal((await flags()).owns_user_objects, true,
          'inherited owner of a user type is denied after CREATE is unavailable');
        await client.query('ALTER TYPE public.inherited_status OWNER TO CURRENT_USER');
        await client.query('DROP TYPE public.inherited_status');
        assert.equal(allowed(await flags()), true);

        await client.query('GRANT CREATE ON DATABASE postgres TO settings_reader');
        await client.query('SET ROLE settings_reader');
        await client.query('CREATE SCHEMA owned_schema');
        await client.query('RESET ROLE');
        await client.query('REVOKE CREATE ON DATABASE postgres FROM settings_reader');
        assert.equal((await flags()).owns_user_objects, true, 'schema ownership is denied after CREATE revoke');
        await client.query('SET ROLE settings_reader');
        await client.query('DROP SCHEMA owned_schema');
        await client.query('RESET ROLE');
        assert.equal(allowed(await flags()), true);

        await client.query('CREATE SCHEMA private_api; REVOKE ALL ON SCHEMA private_api FROM PUBLIC');
        await client.query("CREATE FUNCTION private_api.hidden_routine() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
        assert.equal(allowed(await flags()), true, 'an inaccessible schema does not expose its routine');
        await client.query('GRANT USAGE ON SCHEMA private_api TO settings_reader');
        assert.equal((await flags()).can_execute_routines, true,
          'granting schema USAGE exposes a PUBLIC executable routine');
        await client.query('REVOKE USAGE ON SCHEMA private_api FROM settings_reader');
        await client.query('DROP SCHEMA private_api CASCADE');

        await client.query("CREATE PROCEDURE public.write_private() LANGUAGE sql SECURITY DEFINER AS 'INSERT INTO private_records VALUES (2, ''from-procedure'')'");
        assert.equal((await flags()).can_execute_routines, true, 'PUBLIC executable procedures are denied');
        await client.query('REVOKE EXECUTE ON PROCEDURE public.write_private() FROM PUBLIC');
        assert.equal(allowed(await flags()), true, 'revoked procedure EXECUTE restores admission');
        await client.query('DROP PROCEDURE public.write_private()');
        await client.query('DROP FUNCTION public.expose_secret()');

        await client.query('ALTER ROLE settings_reader CREATEDB');
        assert.equal((await flags()).rolcreatedb, true, 'elevated role attribute is denied');
        await client.query('ALTER ROLE settings_reader NOCREATEDB');

        await client.query('GRANT elevated TO settings_reader WITH INHERIT FALSE, SET TRUE');
        assert.equal((await flags()).only_settings_membership, false, 'direct SET-only alternate role is denied');
        await client.query('REVOKE elevated FROM settings_reader');
        await client.query('GRANT elevated TO settings_reader WITH INHERIT TRUE, SET TRUE');
        assert.equal((await flags()).only_settings_membership, false, 'inherited alternate role is denied');
        await client.query('REVOKE elevated FROM settings_reader');
        assert.equal(allowed(await flags()), true, 'restoring the approved grants restores admission');
      } finally { await client.end(); }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await cleanupCluster(
        () => started ? run(join(postgresBin, 'pg_ctl'), ['-D', data, 'stop', '-m', 'immediate']) : undefined,
        () => rm(directory, { recursive: true, force: true }), primaryError);
    }
  });
