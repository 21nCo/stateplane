-- Statement-level guard also rejects TRUNCATE, which bypasses row triggers.
CREATE TRIGGER space_audit_no_truncate BEFORE TRUNCATE ON space_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_space_audit_change();
CREATE TRIGGER space_provisioning_audit_no_truncate BEFORE TRUNCATE ON space_provisioning_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_space_audit_change();

DROP INDEX agent_key_issuances_space_pending;
CREATE INDEX agent_key_issuances_space_pending ON agent_key_issuances(space_id,created_at)
  WHERE provider_revoked_at IS NULL AND settled_without_key_at IS NULL AND completed_at IS NULL;
