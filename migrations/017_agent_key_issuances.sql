-- This control-plane journal precedes the remote AuthFn create call. Its
-- correlation ID allows recovery even if the cell staging commit loses its ACK
-- or the cell is deleted before the provider returns the generated key ID.
CREATE TABLE agent_key_issuances (
  issuance_id text PRIMARY KEY,
  space_id text NOT NULL,
  owner_principal_id text NOT NULL,
  cell_id text NOT NULL,
  credential_id text,
  provider_revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (issuance_id <> '' AND space_id <> '' AND owner_principal_id <> '' AND cell_id <> '')
);
CREATE INDEX agent_key_issuances_space_pending ON agent_key_issuances(space_id,created_at)
  WHERE provider_revoked_at IS NULL;
REVOKE ALL ON agent_key_issuances FROM PUBLIC;
