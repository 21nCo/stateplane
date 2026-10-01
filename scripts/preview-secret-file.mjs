import { lstat, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Preview tokens use POSIX private files; Windows ACL protection is not qualified. */
export function requirePrivatePreviewHost() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Preview token files require a supported POSIX host');
  }
}

/** Check the parent before creation and remove any token after a failed write or check. */
export async function writePrivatePreviewToken(path, token, { inspectFile = file => file.stat() } = {}) {
  requirePrivatePreviewHost();
  const directory = await lstat(dirname(path));
  const owner = process.getuid();
  if (!directory.isDirectory() || (directory.mode & 0o077) || directory.uid !== owner) {
    throw new Error('Preview token file is not private');
  }
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ PROBE_TOKEN: token }));
    const details = await inspectFile(file);
    if (!details.isFile() || (details.mode & 0o077) || details.uid !== owner) {
      throw new Error('Preview token file is not private');
    }
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await rm(path, { force: true });
    throw error;
  }
}
