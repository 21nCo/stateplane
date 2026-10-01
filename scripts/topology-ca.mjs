import { X509Certificate } from 'node:crypto';
import { sameProviderId } from './topology-live.mjs';

/** Extract exactly one usable CA from Cloudflare's uploaded certificate readback. */
export function parseUploadedCa(body, id, now = Date.now()) {
  if (body?.success !== true || !sameProviderId(body.result?.id, id) || body.result?.ca !== true ||
      typeof body.result.certificates !== 'string') {
    throw new Error('Uploaded Hyperdrive CA certificate is unavailable');
  }
  const pem = body.result.certificates.trim();
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length !== 1 || pem !== blocks[0]) {
    throw new Error('Uploaded Hyperdrive CA must be one unexpired certificate');
  }
  let certificate;
  try { certificate = new X509Certificate(blocks[0]); }
  catch { throw new Error('Uploaded Hyperdrive CA must be one unexpired certificate'); }
  if (!certificate.ca || Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error('Uploaded Hyperdrive CA must be one unexpired certificate');
  }
  return blocks[0];
}

export async function readUploadedCa(id, signal, request = fetch, timeoutMs = 15_000) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '') || !token) throw new Error('Protected Cloudflare account ID and API token required for CA readback');
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await request(`https://api.cloudflare.com/client/v4/accounts/${accountId}/mtls_certificates/${id}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: requestSignal
  });
  if (!response.ok) throw new Error('Uploaded Hyperdrive CA certificate is unavailable');
  return parseUploadedCa(await response.json(), id);
}
