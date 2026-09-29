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
       AND (schema.nspname <> 'public' OR relation.relname NOT IN ('stateplane_qualification', 'stateplane_qualification_attempt'))
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND (has_table_privilege(current_user, relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_any_column_privilege(current_user, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))) AS no_other_table_access,
  NOT EXISTS (SELECT 1 FROM pg_class AS relation
     JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
     WHERE relation.relkind = 'S' AND left(schema.nspname, 3) <> 'pg_'
       AND schema.nspname <> 'information_schema'
       AND has_schema_privilege(current_user, schema.oid, 'USAGE')
       AND has_sequence_privilege(current_user, relation.oid, 'USAGE,SELECT,UPDATE')) AS no_sequence_access,
  NOT EXISTS (SELECT 1 FROM pg_proc AS routine
     JOIN pg_namespace AS schema ON schema.oid = routine.pronamespace
     WHERE left(schema.nspname, 3) <> 'pg_' AND schema.nspname <> 'information_schema'
       AND has_schema_privilege(current_user, schema.oid, 'USAGE')
       AND routine.oid IS DISTINCT FROM to_regprocedure('public.l2_distance(public.vector,public.vector)')
       AND has_function_privilege(current_user, routine.oid, 'EXECUTE')) AS no_other_routine_execute,
  COALESCE(has_function_privilege(current_user,
    to_regprocedure('public.l2_distance(public.vector,public.vector)'), 'EXECUTE'), false) AS can_execute_distance`;

const commonGrantFields = [
  'safe_login', 'no_elevated_membership', 'no_other_role_membership',
  'can_connect', 'no_database_create', 'can_use_schema', 'no_other_schema_create'
];
const qualificationGrantFields = [...commonGrantFields, 'can_create_probe_table', 'no_other_table_access',
  'no_sequence_access', 'no_other_routine_execute', 'can_execute_distance'];
const operationalGrantFields = [...commonGrantFields, 'no_public_schema_create', 'no_owned_objects'];

function grantsAllowed(row, fields) {
  return row !== null && typeof row === 'object' && !Array.isArray(row) &&
    Object.keys(row).length === fields.length &&
    fields.every(field => Object.hasOwn(row, field) && row[field] === true);
}

export function qualificationGrantsAllowed(row) {
  return grantsAllowed(row, qualificationGrantFields);
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
  return grantsAllowed(row, operationalGrantFields);
}
