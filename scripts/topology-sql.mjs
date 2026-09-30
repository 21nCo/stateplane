import { Client } from 'pg';
import { readFile, stat } from 'node:fs/promises';
import { noParameterAdminSql, operationalGrantsAllowed, operationalGrantsSql } from '../deployment/workers/role-grants.js';
import { assertVolumePlacement } from './topology-live.mjs';

export const settingsRoleSql = `WITH RECURSIVE reachable(roleid) AS (
  SELECT oid FROM pg_roles WHERE rolname = current_user
  UNION
  SELECT m.roleid FROM pg_auth_members m JOIN reachable r ON m.member = r.roleid
), owned_catalog_roles(roleid) AS (
  SELECT relowner FROM pg_class UNION ALL SELECT collowner FROM pg_collation
  UNION ALL SELECT conowner FROM pg_conversion UNION ALL SELECT datdba FROM pg_database
  UNION ALL SELECT evtowner FROM pg_event_trigger UNION ALL SELECT extowner FROM pg_extension
  UNION ALL SELECT fdwowner FROM pg_foreign_data_wrapper
  UNION ALL SELECT srvowner FROM pg_foreign_server UNION ALL SELECT lanowner FROM pg_language
  UNION ALL SELECT lomowner FROM pg_largeobject_metadata
  UNION ALL SELECT nspowner FROM pg_namespace UNION ALL SELECT opcowner FROM pg_opclass
  UNION ALL SELECT oprowner FROM pg_operator UNION ALL SELECT opfowner FROM pg_opfamily
  UNION ALL SELECT proowner FROM pg_proc UNION ALL SELECT pubowner FROM pg_publication
  UNION ALL SELECT stxowner FROM pg_statistic_ext UNION ALL SELECT subowner FROM pg_subscription
  UNION ALL SELECT spcowner FROM pg_tablespace UNION ALL SELECT cfgowner FROM pg_ts_config
  UNION ALL SELECT dictowner FROM pg_ts_dict UNION ALL SELECT typowner FROM pg_type
)
SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
  pg_has_role(current_user, 'pg_read_all_settings', 'USAGE') AS can_read_settings,
  ${noParameterAdminSql} AS no_parameter_admin,
  has_database_privilege(current_database(), 'CREATE') AS can_create_database,
  EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND
    has_schema_privilege(n.oid, 'CREATE')) AS can_create_schema,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND
    (has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege(c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))) AS can_access_tables,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND
      CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE,SELECT,UPDATE')
        ELSE false END) AS can_access_sequences,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND
      has_schema_privilege(n.oid, 'USAGE') AND
      has_function_privilege(p.oid, 'EXECUTE')) AS can_execute_routines,
  (current_setting('lo_compat_privileges')::boolean OR EXISTS (SELECT 1 FROM pg_largeobject_metadata m
    WHERE m.lomowner IN (SELECT roleid FROM reachable) OR
      EXISTS (SELECT 1 FROM aclexplode(m.lomacl) acl
        WHERE acl.privilege_type IN ('SELECT', 'UPDATE') AND
          CASE WHEN acl.grantee = 0 THEN true
            ELSE pg_has_role(current_user, acl.grantee, 'USAGE') END))) AS can_access_large_objects,
  (EXISTS (SELECT 1 FROM pg_shdepend
    WHERE refclassid = 'pg_authid'::regclass
      AND refobjid IN (SELECT roleid FROM reachable)
      AND deptype = 'o') OR
    EXISTS (SELECT 1 FROM owned_catalog_roles WHERE roleid IN (SELECT roleid FROM reachable)))
    AS owns_user_objects,
  (SELECT count(*) = 2 AND bool_and(member.rolname IN (current_user, 'pg_read_all_settings'))
    FROM reachable JOIN pg_roles member ON member.oid = reachable.roleid) AS only_settings_membership
  FROM pg_roles r WHERE r.rolname = current_user`;

function assertSettingsRole(label, result) {
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || row?.rolsuper !== false || row.rolcreatedb !== false ||
      row.rolcreaterole !== false || row.rolreplication !== false || row.rolbypassrls !== false ||
      row.can_read_settings !== true || row.no_parameter_admin !== true ||
      row.can_create_database !== false ||
      row.can_create_schema !== false || row.can_access_tables !== false ||
      row.can_access_sequences !== false ||
      row.can_execute_routines !== false ||
      row.can_access_large_objects !== false ||
      row.owns_user_objects !== false ||
      row.only_settings_membership !== true) {
    throw new Error(`${label}: settings proof credential is not least privilege`);
  }
}

export async function readProtectedSqlUrls(path) {
  if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error('Protected SQL URL file must be mode 0600');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // JSON.parse can include a fragment of the input (and its credentials) in its error.
    throw new Error('Protected SQL URL file is unreadable or invalid JSON');
  }
}

/** Prove the declared proxy accepts a verified TLS connection to the intended PostgreSQL database and role. */
export async function verifySqlIdentity({ label, resource, database, proxy, ca, value, ClientType = Client, signal }) {
  const active = () => {
    if (signal?.aborted) throw new Error(`${label}: topology verification interrupted`);
  };
  active();
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
    active();
    const result = await client.query('SELECT current_database() AS database, current_user AS role, version() AS version');
    active();
    if (result.rows[0]?.database !== database || result.rows[0]?.role !== resource.databaseRole ||
        !/^PostgreSQL /i.test(result.rows[0]?.version ?? '')) throw new Error('SQL identity mismatch');
    const grants = await client.query(operationalGrantsSql);
    active();
    if (grants.rows.length !== 1 || !operationalGrantsAllowed(grants.rows[0])) throw new Error('SQL role grants unavailable or excessive');
    const vector = await client.query("SELECT '[1,0,0]'::vector <-> '[0,1,0]'::vector AS distance");
    active();
    if (!Number.isFinite(vector.rows[0]?.distance) || Math.abs(vector.rows[0].distance - Math.SQRT2) > 0.00001) {
      throw new Error('pgvector query mismatch');
    }
  } catch {
    throw new Error(signal?.aborted ? `${label}: topology verification interrupted` : `${label}: verified-TLS SQL identity or pgvector query failed`);
  } finally {
    await client.end().catch(() => {});
  }
}

/** A separate read-only settings credential proves the running server's PGDATA, not just its configured image path. */
export async function verifyPgdataPlacement({ label, volumeInstance, mountPath, database, proxy, ca, value,
  operationalRole, ClientType = Client, signal }) {
  if (signal?.aborted) throw new Error(`${label}: topology verification interrupted`);
  if (typeof value !== 'string') throw new Error(`${label}: protected PGDATA SQL URL missing`);
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${label}: protected PGDATA SQL URL is invalid`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== proxy.domain ||
      Number(url.port) !== proxy.proxyPort || decodeURIComponent(url.pathname.slice(1)) !== database ||
      !url.username || !url.password || decodeURIComponent(url.username) === operationalRole ||
      !operationalRole || url.search || url.hash) {
    throw new Error(`${label}: protected PGDATA SQL URL differs from declared proxy or database`);
  }
  const client = new ClientType({ connectionString: value, connectionTimeoutMillis: 5000, query_timeout: 5000,
    ssl: { ca, rejectUnauthorized: true, servername: proxy.domain } });
  try {
    await client.connect();
    if (signal?.aborted) throw new Error('interrupted');
    const result = await client.query('SELECT current_database() AS database, current_user AS role');
    if (signal?.aborted) throw new Error('interrupted');
    if (result.rows.length !== 1 || result.rows[0].database !== database ||
        result.rows[0].role !== decodeURIComponent(url.username)) throw new Error('SQL identity mismatch');
    assertSettingsRole(label, await client.query(settingsRoleSql));
    if (signal?.aborted) throw new Error('interrupted');
    const placement = await client.query("SELECT current_setting('data_directory') AS data_directory");
    if (signal?.aborted) throw new Error('interrupted');
    if (placement.rows.length !== 1) throw new Error('PGDATA readback missing');
    assertVolumePlacement(label, volumeInstance, mountPath, placement.rows[0].data_directory);
    const spaces = await client.query("SELECT spcname FROM pg_tablespace WHERE spcname NOT IN ('pg_default', 'pg_global')");
    if (signal?.aborted) throw new Error('interrupted');
    if (spaces.rows.length !== 0) throw new Error('Non-default tablespace requires separate storage proof');
  } catch {
    throw new Error(signal?.aborted ? `${label}: topology verification interrupted` : `${label}: verified-TLS PGDATA placement proof failed`);
  } finally {
    await client.end().catch(() => {});
  }
}
