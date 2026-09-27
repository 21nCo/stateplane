import { X509Certificate } from 'node:crypto';

const caNames = {
  'rds-ca-rsa2048-g1': 'RSA2048 G1',
  'rds-ca-rsa4096-g1': 'RSA4096 G1',
  'rds-ca-ecc384-g1': 'ECC384 G1'
};

export function selectRdsRoot(bundle, region, caIdentifier) {
  if (!/^((ap-south|us-east|eu-west)-1)$/.test(region) || !Object.hasOwn(caNames, caIdentifier ?? '')) {
    throw new Error('RDS region or CA identifier is unsupported');
  }
  const blocks = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const expected = `CN=Amazon RDS ${region} Root CA ${caNames[caIdentifier]}`;
  const matches = blocks.filter(pem => {
    const certificate = new X509Certificate(pem);
    return certificate.subject.split('\n').includes(expected);
  });
  if (matches.length !== 1) throw new Error('Matching single regional RDS root CA unavailable');
  const certificate = new X509Certificate(matches[0]);
  if (!certificate.ca || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey) ||
      Date.now() < Date.parse(certificate.validFrom) || Date.now() >= Date.parse(certificate.validTo)) {
    throw new Error('Selected RDS root CA is invalid or expired');
  }
  return { pem: `${matches[0]}\n`, fingerprint256: certificate.fingerprint256 };
}

export function assertUploadedRdsRoot(uploaded, expected) {
  if (uploaded?.ca !== true || typeof uploaded.certificates !== 'string') throw new Error('Uploaded Cloudflare CA certificate unavailable');
  const blocks = uploaded.certificates.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length !== 1 || new X509Certificate(blocks[0]).fingerprint256 !== expected.fingerprint256) {
    throw new Error('Uploaded Cloudflare CA does not match the RDS instance root');
  }
}
