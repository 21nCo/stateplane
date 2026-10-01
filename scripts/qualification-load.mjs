import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupPreview } from './qualification-preview-secret.mjs';

async function collectProbes(requestProbe, remaining, results = []) {
  if (remaining === 0) return results;
  // Each Worker holds one reader while obtaining a writer. Two in flight use
  // at most four of the five origin connections; the fifth remains available.
  const batchSize = Math.min(2, remaining);
  const batch = await Promise.allSettled(Array.from({ length: batchSize }, requestProbe));
  return collectProbes(requestProbe, remaining - batchSize, results.concat(batch));
}

function validateProbeResult(body) {
  if (body.ok !== true || body.rollback !== true || body.freshRead !== true ||
      !Number.isSafeInteger(body.observedConnections) || !Number.isSafeInteger(body.maxConnections) ||
      body.observedConnections < 2 || body.maxConnections < 2 ||
      !Number.isSafeInteger(body.reservedConnections) || body.reservedConnections < 0 ||
      body.maxConnections - body.reservedConnections < body.observedConnections ||
      !Number.isFinite(body.elapsedMs)) throw new Error('Incomplete qualification result');
  return body;
}

function assertLoadArguments(name, concurrency, minimumHeadroom, token) {
  if (!/^s4-[a-f0-9]{40}-[dp]-(apse|use|euw)$/.test(name ?? '') ||
      !Number.isSafeInteger(concurrency) || concurrency < 2 || concurrency > 50 ||
      !Number.isSafeInteger(minimumHeadroom) || minimumHeadroom < 1 || !token || /[\r\n]/.test(token)) {
    throw new Error('Invalid qualification load arguments');
  }
}

function resolveProbeUrl(urls, expectedUrl) {
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
  return url;
}

function makeRequestJson(request, token, signal) {
  return async (target, allowCancel, attempt) => {
    if (allowCancel && signal?.aborted) throw new Error('Qualification load interrupted');
    const timeout = AbortSignal.timeout(30000);
    const response = await request(target, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...(attempt ? { 'x-stateplane-attempt': attempt } : {}) },
      signal: allowCancel && signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
}

async function confirmedStart(url, requestJson, attempt) {
  try {
    const body = await requestJson(`${url}/start`, false, attempt);
    return body.ok === true && body.started === true;
  } catch { return false; }
}

async function firstProbeSucceeded(requestProbe) {
  try { await requestProbe(); return true; }
  catch { return false; }
}

async function residualClean(url, requestJson, attempt) {
  try {
    const residual = await requestJson(`${url}/residual`, false, attempt);
    return residual.ok === true && residual.residualRows === 0;
  } catch { return false; }
}

function attemptIssues(started, serialFailed, failed, concurrency, clean, signal) {
  const issues = [];
  if (!started) issues.push('Qualification attempt start failed');
  if (serialFailed) issues.push('First qualification request failed');
  if (failed.length) issues.push(`${failed.length}/${concurrency} concurrent qualification requests failed`);
  if (!clean) issues.push('Final residual readback failed');
  if (!started) issues.push('Qualification attempt was not confirmed');
  if (signal?.aborted) issues.push('Qualification load interrupted');
  return issues;
}

async function runAttempt(url, concurrency, requestJson, signal) {
  // The database issues a generation before start. A delayed old start can
  // never acquire a newer run's generation, even across independent CLIs.
  const reservation = await requestJson(`${url}/reserve`, false);
  if (reservation.ok !== true || !/^[1-9]\d{0,18}$/.test(reservation.generation ?? '')) {
    throw new Error('Qualification attempt reservation failed');
  }
  const attempt = reservation.generation;
  const requestProbe = async () => validateProbeResult(await requestJson(url, true, attempt));
  const started = await confirmedStart(url, requestJson, attempt);
  // The first probe creates the disposable table. Complete it before any parallel
  // request so PostgreSQL catalog creation cannot race on a fresh database.
  const serialFailed = started && !signal?.aborted && !(await firstProbeSucceeded(requestProbe));
  const results = !started || serialFailed || signal?.aborted ? [] : await collectProbes(requestProbe, concurrency);
  const failed = results.filter(result => result.status === 'rejected');
  // This read follows a failed bootstrap or every settled concurrent request.
  // It uses a fresh timeout even when the caller was interrupted, so cleanup is
  // checked before reporting the interrupted run as failed.
  const clean = await residualClean(url, requestJson, attempt);
  const issues = attemptIssues(started, serialFailed, failed, concurrency, clean, signal);
  if (issues.length) throw new Error(issues.join('; '));
  return results.map(result => result.value);
}

function summarizeLoad(name, url, concurrency, minimumHeadroom, values) {
  const high = Math.max(...values.map(value => value.observedConnections));
  const maximum = Math.min(...values.map(value => value.maxConnections));
  const reserved = Math.max(...values.map(value => value.reservedConnections));
  if (maximum - high - reserved < minimumHeadroom) throw new Error(`Origin connection headroom below ${minimumHeadroom}: observed ${high}/${maximum}, reserved ${reserved}`);
  return { previewName: name, previewUrl: url, requests: concurrency, success: values.length,
    residualRows: 0,
    peakObservedConnections: high, minMaxConnections: maximum, maxReservedConnections: reserved,
    minimumHeadroom: maximum - high - reserved, maxElapsedMs: Math.max(...values.map(value => value.elapsedMs)) };
}

export async function runLoad(name, expectedUrl, concurrency = 10, minimumHeadroom = 5,
  { token = process.env.PROBE_TOKEN, deployPreview = setupPreview, request = fetch, signal } = {}) {
  assertLoadArguments(name, concurrency, minimumHeadroom, token);
  // setupPreview checks the clean head and exact config, deploys the named
  // Preview, and reads its secret binding back before any token-bearing fetch.
  const urls = await deployPreview(name, token, { signal });
  if (signal?.aborted) throw new Error('Qualification load interrupted');
  const url = resolveProbeUrl(urls, expectedUrl);
  const values = await runAttempt(url, concurrency, makeRequestJson(request, token, signal), signal);
  return summarizeLoad(name, url, concurrency, minimumHeadroom, values);
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
