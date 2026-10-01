-- A second unique key lets a contender identify the uncommitted collection by
-- a bounded conflict on a collection it is currently authorized to use.
-- Neither row survives the authority transaction.
CREATE TABLE receipt_reservation_scopes (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  credential_id text NOT NULL CHECK (char_length(credential_id) > 0),
  operation text NOT NULL CHECK (operation IN ('create', 'replace', 'patch', 'delete')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) > 0),
  PRIMARY KEY (space_id, collection_id, credential_id, operation, idempotency_key),
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id)
);
