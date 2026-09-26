import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const passwordFile = resolve(root, '.data/local-db-password');
const operation = process.argv[2];

async function localPassword(create) {
  try {
    return (await readFile(passwordFile, 'utf8')).trim();
  } catch (error) {
    if (!create || error.code !== 'ENOENT') throw error;
    await mkdir(resolve(root, '.data'), { recursive: true, mode: 0o700 });
    const generated = randomBytes(32).toString('hex');
    try {
      await writeFile(passwordFile, `${generated}\n`, { flag: 'wx', mode: 0o600 });
      return generated;
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      return (await readFile(passwordFile, 'utf8')).trim();
    }
  }
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (operation === 'up') {
  const password = await localPassword(true);
  run('docker', ['compose', 'up', '-d', '--wait', 'postgres'], { ...process.env, STATEPLANE_POSTGRES_PASSWORD: password });
} else if (operation === 'migrate') {
  const password = process.env.DATABASE_URL ? null : await localPassword(false);
  const url = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:55432/stateplane`;
  run(process.execPath, ['scripts/migrate.mjs'], { ...process.env, DATABASE_URL: url });
} else if (operation === 'down') {
  const password = await localPassword(false).catch(error => {
    if (error.code === 'ENOENT') return 'not-used-for-down';
    throw error;
  });
  run('docker', ['compose', 'down'], { ...process.env, STATEPLANE_POSTGRES_PASSWORD: password });
} else {
  throw new Error('Usage: node scripts/local-db.mjs up|migrate|down');
}
