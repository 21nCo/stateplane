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
