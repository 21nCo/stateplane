// Check effective privileges through the same PostgreSQL connection used by the probe.
// A matching current_user name alone does not exclude an inherited administrator role.
export const qualificationGrantsSql = `SELECT
  (SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
     FROM pg_roles WHERE rolname = current_user) AS safe_login,
  NOT EXISTS (SELECT 1 FROM pg_roles
     WHERE pg_has_role(current_user, oid, 'MEMBER')
       AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
            OR left(rolname, 3) = 'pg_')) AS no_elevated_membership,
  NOT EXISTS (SELECT 1 FROM pg_roles
     WHERE rolname <> current_user AND pg_has_role(current_user, oid, 'MEMBER')) AS no_other_role_membership,
  has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
  NOT has_database_privilege(current_user, current_database(), 'CREATE') AS no_database_create,
  has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_schema,
  has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_probe_table,
  NOT EXISTS (SELECT 1 FROM pg_namespace
     WHERE nspname <> 'public' AND left(nspname, 3) <> 'pg_'
       AND nspname <> 'information_schema'
       AND has_schema_privilege(current_user, oid, 'CREATE')) AS no_other_schema_create,
  NOT EXISTS (SELECT 1 FROM pg_class AS relation
     JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
     WHERE left(schema.nspname, 3) <> 'pg_' AND schema.nspname <> 'information_schema'
       AND (schema.nspname <> 'public' OR relation.relname <> 'stateplane_qualification')
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND (has_table_privilege(current_user, relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_any_column_privilege(current_user, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))) AS no_other_table_access`;

export function qualificationGrantsAllowed(row) {
  return row !== null && typeof row === 'object' &&
    Object.keys(row).length === 9 &&
    Object.values(row).every(value => value === true);
}

// Operational control/cell roles need grants on application tables after migration.
// Keep the disposable probe's stricter table and CREATE policy separate.
export const operationalGrantsSql = `SELECT
  (SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
     FROM pg_roles WHERE rolname = current_user) AS safe_login,
  NOT EXISTS (SELECT 1 FROM pg_roles
     WHERE pg_has_role(current_user, oid, 'MEMBER')
       AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
            OR left(rolname, 3) = 'pg_')) AS no_elevated_membership,
  NOT EXISTS (SELECT 1 FROM pg_roles
     WHERE rolname <> current_user AND pg_has_role(current_user, oid, 'MEMBER')) AS no_other_role_membership,
  has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
  NOT has_database_privilege(current_user, current_database(), 'CREATE') AS no_database_create,
  has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_schema,
  NOT has_schema_privilege(current_user, 'public', 'CREATE') AS no_public_schema_create,
  NOT EXISTS (SELECT 1 FROM pg_namespace
     WHERE nspname <> 'public' AND left(nspname, 3) <> 'pg_'
       AND nspname <> 'information_schema'
       AND has_schema_privilege(current_user, oid, 'CREATE')) AS no_other_schema_create,
  NOT EXISTS (SELECT 1 FROM pg_shdepend
     WHERE refclassid = 'pg_authid'::regclass
       AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND deptype = 'o') AS no_owned_objects`;

export function operationalGrantsAllowed(row) {
  return row !== null && typeof row === 'object' &&
    Object.keys(row).length === 9 &&
    Object.values(row).every(value => value === true);
}
