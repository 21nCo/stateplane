import { stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Preview tokens use POSIX private files; Windows ACL protection is not qualified. */
export function requirePrivatePreviewHost() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Preview token files require a supported POSIX host');
  }
}

/** Check the private directory and token file before handing its path to Wrangler. */
export async function writePrivatePreviewToken(path, token) {
  requirePrivatePreviewHost();
  await writeFile(path, JSON.stringify({ PROBE_TOKEN: token }), { flag: 'wx', mode: 0o600 });
  const [file, directory] = await Promise.all([stat(path), stat(dirname(path))]);
  const owner = process.getuid();
  if (!file.isFile() || !directory.isDirectory() || (file.mode & 0o077) || (directory.mode & 0o077) ||
      file.uid !== owner || directory.uid !== owner) {
    throw new Error('Preview token file is not private');
  }
}
