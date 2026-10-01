import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { currentCleanHead } from './qualification-artifact.mjs';
import { wrangler } from './qualification-preview-secret.mjs';
import { readWranglerJson } from './wrangler-json.mjs';
import { previewName } from './preview-name.mjs';
import { requirePrivatePreviewHost, writePrivatePreviewToken } from './preview-secret-file.mjs';

const root = resolve(import.meta.dirname, '..');
const suffixes = { control: 'ctl', 'ap-southeast': 'apse', 'us-east': 'use', 'eu-west': 'euw' };

export function operationalConfig(name, hyperdriveId, database, role) {
  if (!/^s4o-[a-f0-9]{40}-[dp]-(ctl|apse|use|euw)$/.test(name) ||
      !/^[a-f0-9]{32}$/i.test(hyperdriveId) ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(database) || !/^[a-z][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error('Invalid operational binding probe configuration');
  }
  const hyperdrive = [{ binding: 'AUTHORITY', id: hyperdriveId }];
  const vars = { STATEPLANE_PROBE_DATABASE: database, STATEPLANE_PROBE_ROLE: role };
  return {
    name, main: resolve(root, 'deployment/workers/operational-verify.ts'),
    compatibility_date: '2026-09-25', compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: true,
    secrets: { required: ['PROBE_TOKEN'] }, hyperdrive, vars,
    previews: { secrets: { required: ['PROBE_TOKEN'] }, hyperdrive, vars }
  };
}

/** Prove that the exact operational Hyperdrive ID works from a disposable Worker. */
export async function verifyOperationalBinding(environment, label, resource, database,
  { token = process.env.PROBE_TOKEN, runWrangler = wrangler, request = fetch, signal,
    getHead = currentCleanHead } = {}) {
  const head = await getHead(root);
  const suffix = suffixes[label];
  const shortEnvironment = { development: 'd', production: 'p' }[environment];
  if (!suffix || !shortEnvironment || (environment === 'production' && label === 'eu-west') ||
      !token || /[\r\n]/.test(token)) throw new Error('Invalid operational binding probe target or token');
  const name = `s4o-${head}-${shortEnvironment}-${suffix}`;
  const config = operationalConfig(name, resource.hyperdriveId, database, resource.databaseRole);
  requirePrivatePreviewHost();
  const directory = await mkdtemp(join(tmpdir(), 'sta4-operational-'));
  const configPath = join(directory, 'wrangler.json');
  const secretPath = join(directory, 'secrets.json');
  const target = ['--name', previewName(name), '--config', configPath, '--ignore-base-config'];
  let attempted = false;
  let failure;
  let evidence;
  try {
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writePrivatePreviewToken(secretPath, token);
    attempted = true;
    const deployed = readWranglerJson(await runWrangler(['preview', ...target, '--secrets-file', secretPath, '--json'], signal));
    const urls = deployed?.preview_urls ?? deployed?.preview?.urls;
    if (!Array.isArray(urls) || urls.length !== 1) throw new Error('Operational Preview URL unavailable or ambiguous');
    const origin = new URL(urls[0]);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
        origin.search || origin.hash) throw new Error('Operational Preview URL is invalid');
    const listed = readWranglerJson(await runWrangler(['preview', 'secret', 'list', ...target, '--json'], signal));
    if (!Array.isArray(listed) || !listed.some(entry => entry.name === 'PROBE_TOKEN' && entry.type === 'secret_text')) {
      throw new Error('Operational Preview token binding missing');
    }
    if (signal?.aborted) throw new Error('Operational Preview interrupted');
    const timeout = AbortSignal.timeout(30000);
    const response = await request(`${origin.origin}/verify`, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}` }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error('Operational Hyperdrive Worker connectivity failed');
    const body = await response.json();
    if (body.ok !== true || body.database !== database || body.role !== resource.databaseRole || body.pgvector !== true) {
      throw new Error('Operational Hyperdrive Worker identity or pgvector mismatch');
    }
    if (signal?.aborted) throw new Error('Operational Preview interrupted');
    evidence = { name, hyperdriveId: resource.hyperdriveId, database, role: resource.databaseRole, previewUrl: origin.origin };
  } catch { failure = new Error(`${environment}/${label}: operational Hyperdrive Worker proof failed`); }
  try {
    if (attempted) await runWrangler(['preview', 'delete', ...target, '--skip-confirmation', '--json']);
  } catch { failure = new Error(`${environment}/${label}: operational Preview cleanup failed`); }
  finally { await rm(directory, { recursive: true, force: true }); }
  if (failure) throw failure;
  return evidence;
}
