-- Fixed authority schema. Every child key carries its space and collection.
CREATE TABLE spaces (
  space_id text PRIMARY KEY CHECK (space_id <> ''),
  owner_principal_id text NOT NULL CHECK (owner_principal_id <> ''),
  home_cell_id text NOT NULL CHECK (home_cell_id <> ''),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'readOnly', 'suspended', 'deleting', 'deleted')),
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  placement_generation bigint NOT NULL DEFAULT 1 CHECK (placement_generation > 0),
  cell_id text NOT NULL CHECK (cell_id <> ''),
  storage_target_id text NOT NULL CHECK (storage_target_id <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE collections (
  space_id text NOT NULL REFERENCES spaces(space_id),
  collection_id text NOT NULL CHECK (collection_id <> ''),
  schema_version bigint NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'readOnly', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id)
);

CREATE TABLE collection_versions (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  canonical_definition text NOT NULL CHECK (octet_length(canonical_definition) <= 1048576),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, version),
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id)
);
-- Bootstrap and upgrade insert the version and switch the pointer in one transaction.
ALTER TABLE collections ADD CONSTRAINT collections_current_version
  FOREIGN KEY (space_id, collection_id, schema_version)
  REFERENCES collection_versions(space_id, collection_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE collection_unique_declarations (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  constraint_name text NOT NULL CHECK (constraint_name <> ''),
  paths text[] NOT NULL CHECK (cardinality(paths) > 0),
  accepted_version bigint NOT NULL,
  PRIMARY KEY (space_id, collection_id, constraint_name),
  FOREIGN KEY (space_id, collection_id, accepted_version)
    REFERENCES collection_versions(space_id, collection_id, version)
);

CREATE TABLE collection_index_declarations (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  field_name text NOT NULL CHECK (field_name <> ''),
  value_kind text NOT NULL CHECK (value_kind IN ('string', 'number', 'boolean', 'date-time')),
  filterable boolean NOT NULL DEFAULT false,
  sortable boolean NOT NULL DEFAULT false,
  ready boolean NOT NULL DEFAULT false,
  accepted_version bigint NOT NULL,
  PRIMARY KEY (space_id, collection_id, field_name),
  FOREIGN KEY (space_id, collection_id, accepted_version)
    REFERENCES collection_versions(space_id, collection_id, version)
);

CREATE TABLE collection_grants (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  credential_id text NOT NULL CHECK (credential_id <> ''),
  capabilities text[] NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY (space_id, collection_id, credential_id),
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id),
  CHECK (capabilities <@ ARRAY['schema:write','records:read','records:write','sources:read','sources:write','claims:read','claims:write','claims:review','events:read','export:read','space:admin']::text[])
);

CREATE TABLE records (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  record_id text NOT NULL CHECK (record_id <> ''),
  revision bigint NOT NULL CHECK (revision > 0),
  schema_version bigint NOT NULL CHECK (schema_version > 0),
  key_mode text NOT NULL CHECK (key_mode IN ('generated', 'external')),
  normalized_key text NOT NULL CHECK (normalized_key <> ''),
  canonical_data text NOT NULL CHECK (octet_length(canonical_data) <= 1048576),
  data jsonb NOT NULL,
  tombstone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, record_id),
  FOREIGN KEY (space_id, collection_id, schema_version)
    REFERENCES collection_versions(space_id, collection_id, version),
  UNIQUE (space_id, collection_id, key_mode, normalized_key)
);
CREATE INDEX records_live_order ON records(space_id, collection_id, created_at, record_id) WHERE NOT tombstone;

CREATE TABLE record_unique_keys (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  constraint_name text NOT NULL CHECK (constraint_name <> ''),
  encoded_value text NOT NULL CHECK (encoded_value <> ''),
  record_id text NOT NULL,
  PRIMARY KEY (space_id, collection_id, constraint_name, encoded_value),
  FOREIGN KEY (space_id, collection_id, constraint_name)
    REFERENCES collection_unique_declarations(space_id, collection_id, constraint_name),
  FOREIGN KEY (space_id, collection_id, record_id) REFERENCES records(space_id, collection_id, record_id)
);
CREATE INDEX record_unique_owner ON record_unique_keys(space_id, collection_id, record_id);

CREATE TABLE record_index_values (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  record_id text NOT NULL,
  field_name text NOT NULL CHECK (field_name <> ''),
  value_kind text NOT NULL CHECK (value_kind IN ('null', 'string', 'number', 'boolean', 'date-time')),
  string_value text COLLATE "C",
  number_value numeric,
  boolean_value boolean,
  time_value text COLLATE "C",
  PRIMARY KEY (space_id, collection_id, record_id, field_name),
  FOREIGN KEY (space_id, collection_id, field_name)
    REFERENCES collection_index_declarations(space_id, collection_id, field_name),
  FOREIGN KEY (space_id, collection_id, record_id) REFERENCES records(space_id, collection_id, record_id),
  CHECK ((value_kind = 'null' AND num_nonnulls(string_value,number_value,boolean_value,time_value) = 0)
    OR (value_kind = 'string' AND string_value IS NOT NULL AND num_nonnulls(string_value,number_value,boolean_value,time_value) = 1)
    OR (value_kind = 'number' AND number_value IS NOT NULL AND num_nonnulls(string_value,number_value,boolean_value,time_value) = 1)
    OR (value_kind = 'boolean' AND boolean_value IS NOT NULL AND num_nonnulls(string_value,number_value,boolean_value,time_value) = 1)
    OR (value_kind = 'date-time' AND time_value IS NOT NULL AND num_nonnulls(string_value,number_value,boolean_value,time_value) = 1))
);
CREATE INDEX record_index_string ON record_index_values(space_id, collection_id, field_name, string_value, record_id) WHERE value_kind = 'string';
CREATE INDEX record_index_number ON record_index_values(space_id, collection_id, field_name, number_value, record_id) WHERE value_kind = 'number';
CREATE INDEX record_index_boolean ON record_index_values(space_id, collection_id, field_name, boolean_value, record_id) WHERE value_kind = 'boolean';
CREATE INDEX record_index_time ON record_index_values(space_id, collection_id, field_name, time_value, record_id) WHERE value_kind = 'date-time';
CREATE INDEX record_index_null ON record_index_values(space_id, collection_id, field_name, record_id) WHERE value_kind = 'null';

CREATE TABLE record_events (
  event_id text PRIMARY KEY CHECK (event_id <> ''),
  space_id text NOT NULL,
  collection_id text NOT NULL,
  record_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  operation text NOT NULL CHECK (operation IN ('create', 'replace', 'patch', 'delete')),
  credential_id text NOT NULL,
  schema_version bigint NOT NULL,
  canonical_data text NOT NULL CHECK (octet_length(canonical_data) <= 1048576),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (space_id, collection_id, record_id, revision),
  FOREIGN KEY (space_id, collection_id, record_id) REFERENCES records(space_id, collection_id, record_id),
  FOREIGN KEY (space_id, collection_id, schema_version) REFERENCES collection_versions(space_id, collection_id, version)
);

CREATE TABLE idempotency_receipts (
  receipt_id text PRIMARY KEY CHECK (receipt_id <> ''),
  space_id text NOT NULL REFERENCES spaces(space_id),
  collection_id text NOT NULL,
  credential_id text NOT NULL CHECK (credential_id <> ''),
  operation text NOT NULL CHECK (operation IN ('create', 'replace', 'patch', 'delete')),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  record_id text NOT NULL,
  response jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (space_id, credential_id, operation, idempotency_key),
  FOREIGN KEY (space_id, collection_id, record_id) REFERENCES records(space_id, collection_id, record_id),
  CHECK (expires_at > committed_at)
);
CREATE INDEX idempotency_receipts_expiry ON idempotency_receipts(expires_at);

CREATE TABLE record_tombstones (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  record_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, record_id),
  FOREIGN KEY (space_id, collection_id, record_id) REFERENCES records(space_id, collection_id, record_id)
);

CREATE TABLE projection_outbox (
  event_id text PRIMARY KEY REFERENCES record_events(event_id),
  space_id text NOT NULL,
  collection_id text NOT NULL,
  record_id text NOT NULL,
  revision bigint NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  delivery_state text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'delivering', 'delivered', 'degraded')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  last_error text,
  FOREIGN KEY (space_id, collection_id, record_id, revision)
    REFERENCES record_events(space_id, collection_id, record_id, revision)
);
CREATE INDEX projection_outbox_claim ON projection_outbox(delivery_state, available_at, event_id);

-- Audit facts cannot be rewritten by an ordinary SQL writer. Outbox delivery
-- fields intentionally remain mutable. Backups retain both, including WAL.
CREATE FUNCTION reject_record_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'record events are immutable';
END;
$$;
REVOKE ALL ON FUNCTION reject_record_event_change() FROM PUBLIC;
CREATE TRIGGER record_events_immutable BEFORE UPDATE OR DELETE ON record_events
  FOR EACH ROW EXECUTE FUNCTION reject_record_event_change();

-- Reserved entity identities: STA-13 will add payload and linkage tables without
-- changing space/collection ownership or the canonical reference shape.
CREATE TABLE entity_refs (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('source', 'claim')),
  entity_id text NOT NULL CHECK (entity_id <> ''),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  tombstone boolean NOT NULL DEFAULT false,
  PRIMARY KEY (space_id, collection_id, kind, entity_id),
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id)
);
