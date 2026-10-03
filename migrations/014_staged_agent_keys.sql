-- A provider key cannot use grants until directory publication and local activation
-- both succeed. Preserve keys issued before this migration as active.
ALTER TABLE space_credentials ADD COLUMN activated_at timestamptz;
UPDATE space_credentials SET activated_at=created_at WHERE revoked_at IS NULL;
