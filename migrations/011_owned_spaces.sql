-- The directory is queried on every route. It contains no grants or credential secrets.
CREATE TABLE space_directory (
  space_id text PRIMARY KEY,
  owner_principal_id text NOT NULL CHECK (owner_principal_id <> ''),
  cell_id text NOT NULL CHECK (cell_id <> ''),
  storage_target_id text NOT NULL CHECK (storage_target_id <> ''),
  lifecycle text NOT NULL CHECK (lifecycle IN ('provisioning','active','readOnly','suspended','deleting','deleted')),
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  placement_generation bigint NOT NULL DEFAULT 1 CHECK (placement_generation > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX space_directory_owner ON space_directory(owner_principal_id, created_at, space_id);

-- Key IDs refer to AuthFn keys, never to their bearer secrets. A key is scoped to one
-- space; its distinct principal can later be attached to a team membership.
CREATE TABLE space_credentials (
  space_id text NOT NULL REFERENCES spaces(space_id),
  credential_id text NOT NULL,
  principal_id text NOT NULL,
  owner_principal_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, credential_id),
  CHECK (credential_id <> '' AND principal_id <> '' AND owner_principal_id <> '')
);

-- One-use assertions prevent a captured route from authorizing a second request.
CREATE TABLE routing_nonces (
  space_id text NOT NULL REFERENCES spaces(space_id),
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (space_id, nonce)
);
CREATE INDEX routing_nonces_expiry ON routing_nonces(expires_at);

CREATE TABLE space_audit (
  audit_id text PRIMARY KEY,
  space_id text NOT NULL REFERENCES spaces(space_id),
  actor_principal_id text NOT NULL,
  credential_id text,
  action text NOT NULL,
  policy_version bigint NOT NULL,
  placement_generation bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX space_audit_space_time ON space_audit(space_id, recorded_at, audit_id);
CREATE TRIGGER space_audit_immutable BEFORE UPDATE OR DELETE ON space_audit
  FOR EACH ROW EXECUTE FUNCTION reject_record_event_change();

-- No default PUBLIC access to new authority tables for disposable roles.
REVOKE ALL ON space_directory, space_credentials, routing_nonces, space_audit FROM PUBLIC;
