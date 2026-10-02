-- Rows are inserted and removed in the same authority transaction. The unique
-- key makes another connection wait only for this receipt identity, and a
-- short transaction-local lock timeout converts that wait into RECEIPT_PENDING.
CREATE TABLE receipt_reservations (
  space_id text NOT NULL REFERENCES spaces(space_id),
  credential_id text NOT NULL CHECK (credential_id <> ''),
  operation text NOT NULL CHECK (operation IN ('create', 'replace', 'patch', 'delete')),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  PRIMARY KEY (space_id, credential_id, operation, idempotency_key)
);
