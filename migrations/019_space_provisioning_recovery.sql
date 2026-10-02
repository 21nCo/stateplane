-- A reserved directory row can outlive its creator before the cell insert.
-- Keep a control-side retirement record because no cell audit row exists then.
CREATE TABLE space_provisioning_audit (
  space_id text PRIMARY KEY REFERENCES space_directory(space_id),
  owner_principal_id text NOT NULL,
  cell_id text NOT NULL,
  action text NOT NULL CHECK (action = 'space:provision-retired'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER space_provisioning_audit_immutable BEFORE UPDATE OR DELETE ON space_provisioning_audit
  FOR EACH ROW EXECUTE FUNCTION reject_record_event_change();
REVOKE ALL ON space_provisioning_audit FROM PUBLIC;
