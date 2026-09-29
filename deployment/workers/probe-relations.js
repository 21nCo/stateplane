// Read catalog metadata, not just the name or effective grants: a preexisting
// updatable view or trigger could otherwise redirect the probe into other data.
export const probeRelationsSql = `SELECT relation.relname, relation.relkind, relation.relpersistence,
  relation.relrowsecurity, relation.relforcerowsecurity,
  pg_get_userbyid(relation.relowner) AS owner,
  (SELECT json_agg(json_build_object('name', attribute.attname,
      'type', format_type(attribute.atttypid, attribute.atttypmod),
      'notNull', attribute.attnotnull, 'default', pg_get_expr(definition.adbin, definition.adrelid),
      'identity', attribute.attidentity, 'generated', attribute.attgenerated) ORDER BY attribute.attnum)
    FROM pg_attribute AS attribute
    LEFT JOIN pg_attrdef AS definition ON definition.adrelid = relation.oid AND definition.adnum = attribute.attnum
    WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS columns,
  (SELECT json_agg(json_build_object('kind', con.contype,
      'columns', con.conkey::smallint[], 'definition', pg_get_constraintdef(con.oid, true))
      ORDER BY con.contype, con.conkey::text)
    FROM pg_constraint AS con WHERE con.conrelid = relation.oid) AS constraints,
  (SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = relation.oid AND NOT tgisinternal) AS triggers,
  (SELECT count(*)::integer FROM pg_rewrite WHERE ev_class = relation.oid) AS rules,
  (SELECT count(*)::integer FROM pg_inherits WHERE inhrelid = relation.oid OR inhparent = relation.oid) AS inheritance,
  namespace.nspname AS schema
  FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.relname IN ('stateplane_qualification', 'stateplane_qualification_attempt')
    AND left(namespace.nspname, 3) <> 'pg_' AND namespace.nspname <> 'information_schema'`;

export function probeRelationAllowed(row) {
  const expected = row.relname === 'stateplane_qualification'
    ? [['probe_id', 'uuid'], ['value', 'integer']]
    : [['singleton', 'boolean'], ['generation', 'bigint'], ['active', 'boolean']];
  const columns = row.columns;
  const constraints = row.constraints;
  if (!Array.isArray(columns) || !Array.isArray(constraints)) return false;
  const exactColumns = columns.length === expected.length && columns.every((column, index) =>
    column.name === expected[index][0] && column.type === expected[index][1] &&
    column.notNull === true && column.default === null && column.identity === '' && column.generated === '');
  const primary = constraints.filter(constraint => constraint.kind === 'p');
  const check = constraints.filter(constraint => constraint.kind === 'c');
  return row.schema === 'public' && row.relkind === 'r' && row.relpersistence === 'p' &&
    row.relrowsecurity === false && row.relforcerowsecurity === false &&
    row.owner === row.current_role && row.triggers === 0 && row.rules === 0 && row.inheritance === 0 &&
    exactColumns && primary.length === 1 && primary[0].columns?.join(',') === '1' &&
    primary[0].definition === `PRIMARY KEY (${expected[0][0]})` &&
    (row.relname === 'stateplane_qualification' ? constraints.length === 1 :
      constraints.length === 2 && check.length === 1 && check[0].definition === 'CHECK (singleton)');
}
