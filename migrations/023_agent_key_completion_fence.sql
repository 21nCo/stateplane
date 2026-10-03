-- A new issuance is not complete until its final cell confirmation has a
-- durable control-plane acknowledgement. Reconciliation may cancel only an
-- incomplete issuance. Older rows retain their existing cell confirmation
-- readback semantics during a rolling upgrade.
ALTER TABLE agent_key_issuances
  ADD COLUMN requires_completion boolean NOT NULL DEFAULT false,
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT agent_key_completion_has_credential CHECK
    (completed_at IS NULL OR (requires_completion AND credential_id IS NOT NULL));
