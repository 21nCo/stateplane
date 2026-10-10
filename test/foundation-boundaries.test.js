import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBoundaries, sourceProblems } from '../scripts/check-boundaries.mjs';

const base = '/fixture';
const browser = join(base, 'app/src/routes/server/+page.svelte');
const server = join(base, 'app/src/routes/server/+page.server.ts');

test('syntax parsing catches commented static imports, exports and dynamic imports in browser modules', () => {
  const sources = [
    `<script lang="ts">import type { RecordRef } from /* comment */ '@stateplane/postgres';</script>`,
    `<script>export { secret } from /* comment */ '$lib/server/secret';</script>`,
    `<script>const module = import('@stateplane/auth');</script>`,
    `<script>const module = import('@stateplane/auth', { with: { type: 'json' } });</script>`,
    `<script>require('@stateplane/postgres', ignored);</script>`,
    `<script>require('@stateplane/postgres', ignored, another);</script>`,
    `<button onclick={() => import('@stateplane/postgres')}>Load</button>`
  ];
  for (const source of sources) assert.ok(sourceProblems(browser, source, base).length > 0);
});

test('package and CLI checks reject forbidden imports with extra call arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stateplane-boundary-cli-'));
  try {
    await mkdir(join(directory, 'packages/api/src'), { recursive: true });
    await mkdir(join(directory, 'app/src'), { recursive: true });
    await writeFile(join(directory, 'packages/api/package.json'), JSON.stringify({ dependencies: {
      '@stateplane/auth': 'workspace:*', '@stateplane/contracts': 'workspace:*', '@stateplane/application': 'workspace:*' } }));
    await writeFile(join(directory, 'packages/api/src/index.ts'), `require('@stateplane/postgres', ignored);`);
    assert.ok((await checkBoundaries(directory)).some(problem => problem.includes('forbidden dependency')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('no-substitution template module loads obey package and browser boundaries', () => {
  const packagePath = join(base, 'packages/api/src/index.ts');
  const packageLoads = [
    'require(`@stateplane/postgres`)',
    'require(`@stateplane/postgres`, ignored)',
    'import(`@stateplane/postgres`)',
    'import(`@stateplane/postgres`, { with: { type: "json" } })',
    'type Secret = typeof import(`@stateplane/postgres`)'
  ];
  for (const source of packageLoads) {
    assert.ok(sourceProblems(packagePath, source, base).some(problem => problem.includes('forbidden dependency')), source);
  }

  const browserLoads = [
    '<script>require(`$lib/server/secret`)</script>',
    '<script>import(`@stateplane/postgres`)</script>',
    '<button onclick={() => import(`$lib/server/secret`)}>Load</button>',
    '<button onclick={() => require(`@stateplane/postgres`, ignored)}>Load</button>'
  ];
  for (const source of browserLoads) {
    assert.ok(sourceProblems(browser, source, base).some(problem => problem.includes('browser imports')), source);
  }

  const windowsBase = 'C:\\fixture';
  const windowsPackage = 'C:\\fixture\\packages\\api\\src\\index.ts';
  const windowsBrowser = 'C:\\fixture\\app\\src\\routes\\+page.svelte';
  assert.ok(sourceProblems(windowsPackage, 'import(`../../postgres/src/index`)', windowsBase).some(problem => problem.includes('forbidden dependency')));
  assert.ok(sourceProblems(windowsBrowser, '<button onclick={() => import(`../lib/server/secret`)}>Load</button>', windowsBase).some(problem => problem.includes('browser imports server package')));

  assert.deepEqual(sourceProblems(server, 'import(`@stateplane/postgres`)', base), []);
  assert.deepEqual(sourceProblems(browser, '<script>import(`@stateplane/contracts`)</script>', base), []);
  assert.deepEqual(sourceProblems(packagePath, 'import(`@stateplane/${name}`)', base), []);
});

test('workspace boundary scan rejects template loads in package and Svelte sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stateplane-boundary-template-'));
  try {
    await mkdir(join(directory, 'packages/api/src'), { recursive: true });
    await mkdir(join(directory, 'app/src/routes'), { recursive: true });
    await writeFile(join(directory, 'packages/api/package.json'), JSON.stringify({ dependencies: {
      '@stateplane/auth': 'workspace:*', '@stateplane/contracts': 'workspace:*', '@stateplane/application': 'workspace:*' } }));
    await writeFile(join(directory, 'packages/api/src/index.ts'), 'void import(`@stateplane/postgres`);');
    await writeFile(join(directory, 'app/src/routes/+page.svelte'), '<script>require(`$lib/server/secret`)</script><button onclick={() => import(`@stateplane/postgres`)}>Load</button>');
    const problems = await checkBoundaries(directory);
    assert.ok(problems.some(problem => problem.includes('forbidden dependency @stateplane/postgres')));
    assert.ok(problems.some(problem => problem.includes('browser imports server package $lib/server/secret')));
    assert.ok(problems.some(problem => problem.includes('browser imports @stateplane/postgres')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('real server modules may import server packages even inside a route named server', () => {
  assert.deepEqual(sourceProblems(server, `import type { RecordRef } from '@stateplane/postgres';`, base), []);
  assert.ok(sourceProblems(browser, `<script>import x from '@stateplane/postgres';</script>`, base).length > 0);
});

test('Windows source and local paths enforce the same package and browser rules', () => {
  const windowsBase = 'C:\\fixture';
  const windowsPackage = 'C:\\fixture\\packages\\api\\src\\index.ts';
  const windowsBrowser = 'C:\\fixture\\app\\src\\routes\\+page.svelte';
  const windowsServer = 'C:\\fixture\\app\\src\\routes\\+page.server.ts';
  assert.ok(sourceProblems(windowsPackage, `import x from '@stateplane/postgres';`, windowsBase).some(problem => problem.includes('forbidden dependency')));
  assert.ok(sourceProblems(windowsPackage, `import x from '../../postgres/src/index';`, windowsBase).some(problem => problem.includes('forbidden dependency')));
  assert.ok(sourceProblems(windowsBrowser, `<script>import x from '@stateplane/postgres';</script>`, windowsBase).some(problem => problem.includes('browser imports')));
  assert.ok(sourceProblems(windowsBrowser, `<script>import x from '../lib/server/secret';</script>`, windowsBase).some(problem => problem.includes('browser imports server package')));
  assert.deepEqual(sourceProblems(windowsServer, `import type { RecordRef } from '@stateplane/postgres';`, windowsBase), []);
});

test('unknown package roles fail clearly and dependency key order is irrelevant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stateplane-boundary-'));
  try {
    await mkdir(join(directory, 'packages/api/src'), { recursive: true });
    await mkdir(join(directory, 'app/src'), { recursive: true });
    await writeFile(join(directory, 'packages/api/package.json'), JSON.stringify({ dependencies: {
      '@stateplane/auth': 'workspace:*', '@stateplane/contracts': 'workspace:*', '@stateplane/application': 'workspace:*' } }));
    await writeFile(join(directory, 'packages/api/src/index.ts'), 'export const ok = true;');
    assert.deepEqual(await checkBoundaries(directory), []);
    await mkdir(join(directory, 'packages/unknown/src'), { recursive: true });
    await writeFile(join(directory, 'packages/unknown/package.json'), '{}');
    await writeFile(join(directory, 'packages/unknown/src/index.ts'), `import x from '@stateplane/contracts';`);
    assert.ok((await checkBoundaries(directory)).some(problem => problem.includes('unknown package role')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
