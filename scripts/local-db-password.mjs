import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Reject an interrupted or manually damaged local credential file. */
async function readPublished(path) {
  const value = (await readFile(path, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Local database password file is incomplete or invalid');
  return value;
}

/** Publish a complete local password once, even when bootstrap processes race. */
export async function localPassword(root, create) {
  const directory = join(root, '.data');
  const passwordFile = join(directory, 'local-db-password');
  try {
    return await readPublished(passwordFile);
  } catch (error) {
    if (!create || error.code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const generated = randomBytes(32).toString('hex');
  const temporary = join(directory, `local-db-password.${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, `${generated}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, passwordFile);
      return generated;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return await readPublished(passwordFile);
    }
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
