-- PostgreSQL jsonb cannot represent the valid JSON string scalar U+0000.
-- canonical_data remains the lossless authority; NULL marks records whose
-- optional jsonb projection cannot represent that scalar.
ALTER TABLE records ALTER COLUMN data DROP NOT NULL;
COMMENT ON COLUMN records.data IS 'Optional jsonb projection. NULL when canonical_data contains U+0000, which PostgreSQL jsonb cannot represent; read canonical_data for authority.';
