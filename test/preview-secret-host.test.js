import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupPreview } from '../scripts/qualification-preview-secret.mjs';
import { verifyOperationalBinding } from '../scripts/operational-binding.mjs';
import { writePrivatePreviewToken } from '../scripts/preview-secret-file.mjs';

test('both Preview paths reject Windows before creating a token file or invoking Wrangler', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let calls = 0;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const runWrangler = async () => { calls++; throw new Error('Wrangler must not run'); };
    await assert.rejects(setupPreview(`s4-${'a'.repeat(40)}-d-apse`, 'test-token', { runWrangler }),
      /Preview token files require a supported POSIX host/);
    await assert.rejects(verifyOperationalBinding('development', 'control',
      { hyperdriveId: 'b'.repeat(32), databaseRole: 'cell_reader' }, 'stateplane_dev_control',
      { token: 'test-token', getHead: async () => 'a'.repeat(40), runWrangler }),
    /Preview token files require a supported POSIX host/);
    assert.equal(calls, 0);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('Preview token writer rejects a directory accessible to other users', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-open-preview-'));
  const tokenFile = join(directory, 'secrets.json');
  try {
    await chmod(directory, 0o755);
    await assert.rejects(writePrivatePreviewToken(tokenFile, 'test-token'), /Preview token file is not private/);
    await assert.rejects(readFile(tokenFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a post-create validation failure removes the token, while a valid parent retains a private file',
  { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-private-preview-'));
    const tokenFile = join(directory, 'secrets.json');
    try {
      await assert.rejects(writePrivatePreviewToken(tokenFile, 'test-token', {
        inspectFile: async () => { throw new Error('file inspection failed'); }
      }), /file inspection failed/);
      await assert.rejects(readFile(tokenFile), { code: 'ENOENT' });
      await writePrivatePreviewToken(tokenFile, 'test-token');
      assert.equal((await stat(tokenFile)).mode & 0o077, 0);
      assert.equal(JSON.parse(await readFile(tokenFile)).PROBE_TOKEN, 'test-token');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
