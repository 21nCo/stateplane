import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { localPassword } from './local-db-password.mjs';

const root = resolve(import.meta.dirname, '..');
const operation = process.argv[2];

/** Run one local bootstrap command and preserve its exit status. */
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (operation === 'up') {
  await localPassword(root, true);
  run('docker', ['compose', 'up', '-d', '--wait', 'postgres'], process.env);
} else if (operation === 'migrate') {
  const password = process.env.DATABASE_URL ? null : await localPassword(root, false);
  const url = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:55432/stateplane`;
  run(process.execPath, ['scripts/migrate.mjs'], { ...process.env, DATABASE_URL: url });
} else if (operation === 'down') {
  run('docker', ['compose', 'down'], process.env);
} else {
  throw new Error('Usage: node scripts/local-db.mjs up|migrate|down');
}
