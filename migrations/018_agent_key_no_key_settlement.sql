-- A completed provider create failure can be proven empty by correlation
-- readback. Keep this distinct from revocation of a key that existed.
ALTER TABLE agent_key_issuances ADD COLUMN settled_without_key_at timestamptz;
ALTER TABLE agent_key_issuances ADD COLUMN create_failed_at timestamptz;
ALTER TABLE agent_key_issuances ADD CONSTRAINT agent_key_settlement_exclusive
  CHECK (settled_without_key_at IS NULL OR (credential_id IS NULL AND provider_revoked_at IS NULL));
DROP INDEX agent_key_issuances_space_pending;
CREATE INDEX agent_key_issuances_space_pending ON agent_key_issuances(space_id,created_at)
  WHERE provider_revoked_at IS NULL AND settled_without_key_at IS NULL;
