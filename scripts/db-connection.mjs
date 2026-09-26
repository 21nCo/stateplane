import { readFileSync } from 'node:fs';

export function connectionOptions(value, rootCertPath = process.env.PGSSLROOTCERT) {
  if (!value) throw new Error('DATABASE_URL is required; run pnpm db:up or export a private URL');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (loopback) return { connectionString: value, connectionTimeoutMillis: 5000 };
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
