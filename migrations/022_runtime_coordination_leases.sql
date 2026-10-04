-- Hyperdrive transaction pooling cannot preserve session advisory locks.
-- A short control-side claim fences live issuance/reconciliation without
-- holding a database connection across an external AuthFn call.
ALTER TABLE space_directory
  ADD COLUMN provisioning_lease_until timestamptz,
  ADD COLUMN issuance_lease_token text,
  ADD COLUMN issuance_lease_until timestamptz,
  ADD CONSTRAINT issuance_lease_pair CHECK
    ((issuance_lease_token IS NULL) = (issuance_lease_until IS NULL));
