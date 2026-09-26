import { readFileSync } from 'node:fs';

/** Build pg options from a URL without allowing query fields to override the selected host or TLS policy. */
export function connectionOptions(value, rootCertPath = process.env.PGSSLROOTCERT) {
  if (!value) throw new Error('DATABASE_URL is required; run pnpm db:up or export a private URL');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('DATABASE_URL must include a host');
  for (const key of url.searchParams.keys()) {
    if (!['sslmode', 'application_name'].includes(key)) {
      throw new Error(`DATABASE_URL query option ${key} is not allowed`);
    }
  }
  if (url.searchParams.getAll('sslmode').length > 1) throw new Error('DATABASE_URL has duplicate sslmode options');
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (loopback) {
    if (url.searchParams.has('sslmode') && url.searchParams.get('sslmode') !== 'disable') {
      throw new Error('Loopback DATABASE_URL only permits sslmode=disable');
    }
    url.searchParams.delete('sslmode');
    return { connectionString: url.toString(), connectionTimeoutMillis: 5000 };
  }
  if (url.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('External DATABASE_URL requires sslmode=verify-full');
  }
  url.searchParams.delete('sslmode');
  return {
    connectionString: url.toString(),
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: true, servername: host, ...(rootCertPath ? { ca: readFileSync(rootCertPath, 'utf8') } : {}) }
  };
}
