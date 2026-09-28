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
