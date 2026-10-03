-- An uncertain activation acknowledgement must leave a created key unusable.
-- Pre-migration keys were already issued and retain their existing authority.
ALTER TABLE space_credentials ADD COLUMN confirmed_at timestamptz;
UPDATE space_credentials SET confirmed_at=activated_at WHERE activated_at IS NOT NULL AND revoked_at IS NULL;
