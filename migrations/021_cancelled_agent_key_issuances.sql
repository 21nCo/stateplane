-- A destructive lifecycle transition may cancel an issuer that is waiting on
-- its provider. Keep that decision in the retained control journal so a late
-- provider response cannot resume the issuance after regional erasure.
ALTER TABLE agent_key_issuances ADD COLUMN cancelled_at timestamptz;
