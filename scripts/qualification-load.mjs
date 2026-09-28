const [url, concurrencyText = '10', minimumHeadroomText = '5'] = process.argv.slice(2);
const concurrency = Number(concurrencyText);
const minimumHeadroom = Number(minimumHeadroomText);
if (!(url ?? '').startsWith('https://') || !Number.isSafeInteger(concurrency) || concurrency < 2 || concurrency > 50 ||
    !Number.isSafeInteger(minimumHeadroom) || minimumHeadroom < 1 || !process.env.PROBE_TOKEN) {
  console.error('Usage: PROBE_TOKEN=<secret> node scripts/qualification-load.mjs <https-preview-qualify-url> [concurrency 2..50] [minimum-headroom]');
  process.exit(2);
}
const results = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${process.env.PROBE_TOKEN}` }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.ok !== true || body.rollback !== true || body.freshRead !== true ||
      !Number.isSafeInteger(body.observedConnections) || !Number.isSafeInteger(body.maxConnections) ||
      body.observedConnections < 2 || body.maxConnections < 2 ||
      !Number.isSafeInteger(body.reservedConnections) || body.reservedConnections < 0 ||
      body.maxConnections - body.reservedConnections < body.observedConnections ||
      !Number.isFinite(body.elapsedMs)) throw new Error('Incomplete qualification result');
  return body;
}));
const failed = results.filter(result => result.status === 'rejected');
if (failed.length) throw new Error(`${failed.length}/${concurrency} concurrent qualification requests failed`);
const values = results.map(result => result.value);
const high = Math.max(...values.map(value => value.observedConnections));
const maximum = Math.min(...values.map(value => value.maxConnections));
const reserved = Math.max(...values.map(value => value.reservedConnections));
if (maximum - high - reserved < minimumHeadroom) throw new Error(`Origin connection headroom below ${minimumHeadroom}: observed ${high}/${maximum}, reserved ${reserved}`);
console.log(JSON.stringify({ requests: concurrency, success: values.length, peakObservedConnections: high,
  minMaxConnections: maximum, maxReservedConnections: reserved, minimumHeadroom: maximum - high - reserved,
  maxElapsedMs: Math.max(...values.map(value => value.elapsedMs)) }));
