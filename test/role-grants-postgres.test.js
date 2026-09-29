import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { qualificationGrantsAllowed, qualificationGrantsSql, operationalGrantsAllowed, operationalGrantsSql } from '../deployment/workers/role-grants.js';

const run = promisify(execFile);
let postgresBin;
try {
  const version = execFileSync('pg_config', ['--version'], { encoding: 'utf8' });
  if (/PostgreSQL 1[6-9]\./.test(version)) {
    const bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    await Promise.all([access(join(bin, 'initdb'), constants.X_OK), access(join(bin, 'pg_ctl'), constants.X_OK)]);
    postgresBin = bin;
  }
} catch { /* The project unit suite also runs without a local PostgreSQL installation. */ }

test('grant results require the exact nine true fields of their distinct SQL policies', () => {
  const common = {
    safe_login: true, no_elevated_membership: true, no_other_role_membership: true,
    can_connect: true, no_database_create: true, can_use_schema: true,
    no_other_schema_create: true
  };
  const qualification = { ...common, can_create_probe_table: true, no_other_table_access: true };
  const operational = { ...common, no_public_schema_create: true, no_owned_objects: true };
  assert.equal(qualificationGrantsAllowed(qualification), true);
  assert.equal(operationalGrantsAllowed(operational), true);
  assert.equal(qualificationGrantsAllowed(operational), false);
  assert.equal(operationalGrantsAllowed(qualification), false);
  for (const allowed of [qualificationGrantsAllowed, operationalGrantsAllowed]) {
    assert.equal(allowed(null), false);
    assert.equal(allowed([]), false);
    assert.equal(allowed({ ...common, unrelated: true, another: true }), false);
  }
  for (const [allowed, row] of [[qualificationGrantsAllowed, qualification], [operationalGrantsAllowed, operational]]) {
    assert.equal(allowed({ ...row, safe_login: 'true' }), false);
    assert.equal(allowed({ ...row, safe_login: false }), false);
    const missing = { ...row };
    delete missing.safe_login;
    assert.equal(allowed(missing), false);
    const renamed = { ...missing, unexpected: true };
    assert.equal(allowed(renamed), false);
    assert.equal(allowed({ ...row, unexpected: true }), false);
  }
});

test('PostgreSQL 16 role admission rejects direct, inherited and indirect alternate roles before DDL',
  { skip: !postgresBin || process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-role-grants-'));
    const data = join(directory, 'db');
    let started = false;
    try {
      await run(join(postgresBin, 'initdb'), ['-D', data, '--auth-local=trust', '--auth-host=trust']);
      await run(join(postgresBin, 'pg_ctl'), ['-D', data, '-o', `-k ${directory} -c listen_addresses='' -p 5432`, '-l', join(directory, 'log'), 'start']);
      started = true;
      const client = new Client({ host: directory, database: 'postgres' });
      await client.connect();
      try {
        await client.query(`CREATE ROLE probe LOGIN;
          CREATE ROLE operational LOGIN;
          CREATE ROLE reader;
          CREATE ROLE reader_parent;
          CREATE ROLE migration_owner;
          CREATE TABLE unrelated (id integer);
          GRANT USAGE, CREATE ON SCHEMA public TO probe;
          GRANT SELECT ON unrelated TO operational, reader;`);
        const check = async (role, sql) => {
          await client.query(`SET ROLE ${role}`);
          try { return (await client.query(sql)).rows[0]; }
          finally { await client.query('RESET ROLE'); }
        };
        assert.equal(qualificationGrantsAllowed(await check('probe', qualificationGrantsSql)), true);
        assert.equal(operationalGrantsAllowed(await check('operational', operationalGrantsSql)), true,
          'application table grants remain valid after schema migration');
        await client.query('GRANT CREATE ON SCHEMA public TO operational');
        assert.equal(operationalGrantsAllowed(await check('operational', operationalGrantsSql)), false,
          'an operational role with public schema CREATE must be rejected');
        await client.query('REVOKE CREATE ON SCHEMA public FROM operational');
        assert.equal(operationalGrantsAllowed(await check('operational', operationalGrantsSql)), true,
          'revoking CREATE restores admission without losing migrated table grants');

        const owned = [
          ['table', 'CREATE TABLE owned_records (id integer)', 'ALTER TABLE owned_records OWNER TO migration_owner'],
          ['view', 'CREATE VIEW owned_view AS SELECT id FROM unrelated', 'ALTER VIEW owned_view OWNER TO migration_owner'],
          ['sequence', 'CREATE SEQUENCE owned_sequence', 'ALTER SEQUENCE owned_sequence OWNER TO migration_owner'],
          ['function', "CREATE FUNCTION owned_fn() RETURNS integer LANGUAGE SQL AS 'SELECT 1'", 'ALTER FUNCTION owned_fn() OWNER TO migration_owner'],
          ['type', "CREATE TYPE owned_type AS ENUM ('x')", 'ALTER TYPE owned_type OWNER TO migration_owner']
        ];
        for (const [kind, create, transfer] of owned) {
          await client.query('GRANT CREATE ON SCHEMA public TO operational');
          await client.query('SET ROLE operational');
          try { await client.query(create); }
          finally { await client.query('RESET ROLE'); }
          await client.query('REVOKE CREATE ON SCHEMA public FROM operational');
          assert.equal(operationalGrantsAllowed(await check('operational', operationalGrantsSql)), false,
            `operational ownership of a ${kind} must fail even after CREATE is revoked`);
          await client.query(transfer);
          assert.equal(operationalGrantsAllowed(await check('operational', operationalGrantsSql)), true,
            `transferring the ${kind} to a migration role restores admission`);
        }
        await client.query('CREATE SCHEMA owned_schema AUTHORIZATION operational');
        assert.equal(operationalGrantsAllowed(await check('operational', operationalGrantsSql)), false,
          'owning an alternate schema must fail');
        await client.query('ALTER SCHEMA owned_schema OWNER TO migration_owner');
        assert.equal(operationalGrantsAllowed(await check('operational', operationalGrantsSql)), true);
        await client.query('GRANT CREATE ON SCHEMA public TO operational');
        await client.query('SET ROLE operational');
        try {
          await client.query('CREATE TABLE owned_partitioned (id integer) PARTITION BY RANGE (id)');
          await client.query('CREATE TABLE owned_partition PARTITION OF owned_partitioned FOR VALUES FROM (0) TO (10)');
        } finally { await client.query('RESET ROLE'); }
        await client.query('REVOKE CREATE ON SCHEMA public FROM operational');
        await client.query('ALTER TABLE owned_partitioned OWNER TO migration_owner');
        assert.equal(operationalGrantsAllowed(await check('operational', operationalGrantsSql)), false,
          'an operational-owned partition still fails after transferring its parent');
        await client.query('ALTER TABLE owned_partition OWNER TO migration_owner');
        assert.equal(operationalGrantsAllowed(await check('operational', operationalGrantsSql)), true);

        await client.query('GRANT reader TO probe WITH INHERIT FALSE, SET TRUE');
        const settable = await check('probe', qualificationGrantsSql);
        assert.equal(settable.no_other_table_access, true, 'current-user table check cannot see a SET-only grant');
        assert.equal(qualificationGrantsAllowed(settable), false);
        await client.query('SET ROLE probe');
        await client.query('SET ROLE reader');
        assert.equal((await client.query('SELECT count(*)::integer AS count FROM unrelated')).rows[0].count, 0);
        await client.query('RESET ROLE');

        await client.query('REVOKE reader FROM probe; GRANT reader TO probe WITH INHERIT TRUE, SET TRUE');
        assert.equal(qualificationGrantsAllowed(await check('probe', qualificationGrantsSql)), false);
        await client.query('REVOKE reader FROM probe; GRANT reader TO reader_parent; GRANT reader_parent TO probe WITH INHERIT FALSE, SET TRUE');
        assert.equal(qualificationGrantsAllowed(await check('probe', qualificationGrantsSql)), false);
        await client.query('GRANT reader_parent TO operational WITH INHERIT FALSE, SET TRUE');
        assert.equal(operationalGrantsAllowed(await check('operational', operationalGrantsSql)), false);
      } finally { await client.end(); }
    } finally {
      if (started) await run(join(postgresBin, 'pg_ctl'), ['-D', data, 'stop', '-m', 'immediate']);
      await rm(directory, { recursive: true, force: true });
    }
  });
