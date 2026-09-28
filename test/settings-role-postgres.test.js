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

const run = promisify(execFile);
let postgresBin;
try {
  const version = execFileSync('pg_config', ['--version'], { encoding: 'utf8' });
  if (/PostgreSQL 1[6-9]\./.test(version)) {
    const bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    await Promise.all([access(join(bin, 'initdb'), constants.X_OK), access(join(bin, 'pg_ctl'), constants.X_OK)]);
    postgresBin = bin;
  }
} catch { /* The hermetic suite also runs without local PostgreSQL. */ }

test('real PostgreSQL settings proof rejects transitive roles and column grants',
  { skip: !postgresBin || process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-settings-role-'));
    const data = join(directory, 'db');
    let started = false;
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
        const flags = async () => {
          await client.query('SET ROLE settings_reader');
          try { return (await client.query(settingsRoleSql)).rows[0]; }
          finally { await client.query('RESET ROLE'); }
        };
        const allowed = row => row.can_read_settings && row.only_settings_membership &&
          !row.can_access_tables && !row.can_create_database && !row.can_create_schema;
        assert.equal(allowed(await flags()), true, 'direct settings membership is sufficient');

        await client.query('GRANT elevated TO pg_read_all_settings WITH INHERIT FALSE, SET TRUE');
        assert.equal((await flags()).only_settings_membership, false,
          'an alternate role reachable through the approved role must be rejected');
        await client.query('SET ROLE settings_reader');
        await client.query('SET ROLE elevated');
        assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, 'elevated');
        await client.query('RESET ROLE');
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
    } finally {
      if (started) await run(join(postgresBin, 'pg_ctl'), ['-D', data, 'stop', '-m', 'immediate']);
      await rm(directory, { recursive: true, force: true });
    }
  });
