import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupPreview } from './qualification-preview-secret.mjs';

export async function runLoad(name, expectedUrl, concurrency = 10, minimumHeadroom = 5,
  { token = process.env.PROBE_TOKEN, deployPreview = setupPreview, request = fetch, signal } = {}) {
  if (!/^s4-[a-f0-9]{40}-[dp]-(apse|use|euw)$/.test(name ?? '') ||
      !Number.isSafeInteger(concurrency) || concurrency < 2 || concurrency > 50 ||
      !Number.isSafeInteger(minimumHeadroom) || minimumHeadroom < 1 || !token || /[\r\n]/.test(token)) {
    throw new Error('Invalid qualification load arguments');
  }
  // setupPreview checks the clean head and exact config, deploys the named
  // Preview, and reads its secret binding back before any token-bearing fetch.
  const urls = await deployPreview(name, token, { signal });
  if (signal?.aborted) throw new Error('Qualification load interrupted');
  const targets = (Array.isArray(urls) ? urls : []).flatMap(previewUrl => {
    try {
      const base = new URL(previewUrl);
      return base.protocol === 'https:' && !base.username && !base.password &&
        base.pathname === '/' && !base.search && !base.hash
        ? [`${base.origin}/qualify`] : [];
    } catch { return []; }
  });
  const url = expectedUrl ? targets.find(target => target === expectedUrl) : targets[0];
  if (!url) throw new Error('Probe URL does not match the named Preview deployment');

  async function requestJson(target, allowCancel) {
    if (allowCancel && signal?.aborted) throw new Error('Qualification load interrupted');
    const timeout = AbortSignal.timeout(30000);
    const response = await request(target, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}` }, signal: allowCancel && signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function requestProbe() {
    const body = await requestJson(url, true);
    if (body.ok !== true || body.rollback !== true || body.freshRead !== true ||
        !Number.isSafeInteger(body.observedConnections) || !Number.isSafeInteger(body.maxConnections) ||
        body.observedConnections < 2 || body.maxConnections < 2 ||
        !Number.isSafeInteger(body.reservedConnections) || body.reservedConnections < 0 ||
        body.maxConnections - body.reservedConnections < body.observedConnections ||
        !Number.isFinite(body.elapsedMs)) throw new Error('Incomplete qualification result');
    return body;
  }
  // The first probe creates the disposable table. Complete it before any parallel
  // request so PostgreSQL catalog creation cannot race on a fresh database.
  let serialFailure;
  try { await requestProbe(); }
  catch (error) { serialFailure = error; }
  const results = serialFailure ? [] : await Promise.allSettled(Array.from({ length: concurrency }, requestProbe));
  const failed = results.filter(result => result.status === 'rejected');
  const issues = [];
  if (serialFailure) issues.push('First qualification request failed');
  if (failed.length) issues.push(`${failed.length}/${concurrency} concurrent qualification requests failed`);
  // This read follows a failed bootstrap or every settled concurrent request.
  // It uses a fresh timeout even when the caller was interrupted, so cleanup is
  // checked before reporting the interrupted run as failed.
  try {
    const residual = await requestJson(`${url}/residual`, false);
    if (residual.ok !== true || residual.residualRows !== 0) throw new Error('Residual rows remain');
  } catch { issues.push('Final residual readback failed'); }
  if (signal?.aborted) issues.push('Qualification load interrupted');
  if (issues.length) throw new Error(issues.join('; '));
  const values = results.map(result => result.value);
  const high = Math.max(...values.map(value => value.observedConnections));
  const maximum = Math.min(...values.map(value => value.maxConnections));
  const reserved = Math.max(...values.map(value => value.reservedConnections));
  if (maximum - high - reserved < minimumHeadroom) throw new Error(`Origin connection headroom below ${minimumHeadroom}: observed ${high}/${maximum}, reserved ${reserved}`);
  return { previewName: name, previewUrl: url, requests: concurrency, success: values.length,
    residualRows: 0,
    peakObservedConnections: high, minMaxConnections: maximum, maxReservedConnections: reserved,
    minimumHeadroom: maximum - high - reserved, maxElapsedMs: Math.max(...values.map(value => value.elapsedMs)) };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [name, concurrencyText = '10', minimumHeadroomText = '5', expectedUrl] = process.argv.slice(2);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    console.log(JSON.stringify(await runLoad(name, expectedUrl, Number(concurrencyText), Number(minimumHeadroomText),
      { signal: controller.signal })));
  } catch (error) {
    if (controller.signal.aborted) {
      console.error('Qualification load interrupted');
      process.exitCode = 130;
    } else {
      console.error(error instanceof Error ? error.message : 'Qualification load failed');
      process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
