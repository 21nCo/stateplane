-- Space audits survive erasure. The record-event trigger permits scoped purges,
-- so audit tables need their own unconditional guard on existing databases.
CREATE FUNCTION reject_space_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'space audit rows are immutable';
END;
$$;
REVOKE ALL ON FUNCTION reject_space_audit_change() FROM PUBLIC;

DROP TRIGGER space_audit_immutable ON space_audit;
CREATE TRIGGER space_audit_immutable BEFORE UPDATE OR DELETE ON space_audit
  FOR EACH ROW EXECUTE FUNCTION reject_space_audit_change();

DROP TRIGGER space_provisioning_audit_immutable ON space_provisioning_audit;
CREATE TRIGGER space_provisioning_audit_immutable BEFORE UPDATE OR DELETE ON space_provisioning_audit
  FOR EACH ROW EXECUTE FUNCTION reject_space_audit_change();
