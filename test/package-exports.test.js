import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyRoot } from '../scripts/qualify-exports.mjs';

test('qualification loads a declared CommonJS root and rejects a broken one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stateplane-cjs-'));
  try {
    const esm = join(directory, 'entry.mjs');
    const cjs = join(directory, 'entry.cjs');
    await writeFile(esm, 'export const ready = true;');
    await writeFile(cjs, 'throw new Error("broken CommonJS entry");');
    const requireFixture = createRequire(join(directory, 'consumer.cjs'));
    await assert.rejects(() => verifyRoot('fixture', { import: './entry.mjs', require: './entry.cjs' },
      () => import(pathToFileURL(esm)), () => requireFixture(cjs)), /broken CommonJS entry/);
    await writeFile(cjs, 'module.exports = { ready: true };');
    await verifyRoot('fixture', { import: './entry.mjs', require: './entry.cjs' },
      () => import(pathToFileURL(esm)), () => requireFixture(cjs));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
