import { Client } from 'pg';
import { readFile, stat } from 'node:fs/promises';

export async function readProtectedSqlUrls(path) {
  if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error('Protected SQL URL file must be mode 0600');
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Prove the declared proxy accepts a verified TLS connection to the intended PostgreSQL database and role. */
export async function verifySqlIdentity(label, resource, database, proxy, ca, value, ClientType = Client) {
  if (typeof value !== 'string') throw new Error(`${label}: protected SQL URL missing`);
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${label}: protected SQL URL is invalid`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== proxy.domain ||
      Number(url.port) !== proxy.proxyPort || decodeURIComponent(url.pathname.slice(1)) !== database ||
      decodeURIComponent(url.username) !== resource.databaseRole || url.search) {
    throw new Error(`${label}: protected SQL URL differs from declared proxy, database or role`);
  }
  const client = new ClientType({ connectionString: value, connectionTimeoutMillis: 5000, query_timeout: 5000,
    ssl: { ca, rejectUnauthorized: true, servername: proxy.domain } });
  try {
    await client.connect();
    const result = await client.query('SELECT current_database() AS database, current_user AS role, version() AS version');
    if (result.rows[0]?.database !== database || result.rows[0]?.role !== resource.databaseRole ||
        !/^PostgreSQL /i.test(result.rows[0]?.version ?? '')) throw new Error('SQL identity mismatch');
    const vector = await client.query("SELECT '[1,0,0]'::vector <-> '[0,1,0]'::vector AS distance");
    if (!Number.isFinite(vector.rows[0]?.distance) || Math.abs(vector.rows[0].distance - Math.SQRT2) > 0.00001) {
      throw new Error('pgvector query mismatch');
    }
  } catch {
    throw new Error(`${label}: verified-TLS SQL identity or pgvector query failed`);
  } finally {
    await client.end().catch(() => {});
  }
}
