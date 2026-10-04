-- Local denial and provider revocation are separate durable steps. A failed provider
-- call remains retryable after grants are removed and while deletion is fenced.
ALTER TABLE space_credentials ADD COLUMN provider_revoked_at timestamptz;
