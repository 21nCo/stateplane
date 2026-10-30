-- STA-33: each original's bytes live under a key of their own, recorded here,
-- instead of being shared by (space, sha256). A key is written only by the
-- upload attempt that commits it and deleted only after that attempt has
-- durably failed, so a delete that lands late can never remove bytes another
-- source relies on.
-- A key spells out the space ID (up to 256 characters) and the generated grant
-- and attempt IDs, so 2,048 bytes leaves room.
ALTER TABLE original_objects ADD COLUMN object_key text
  CHECK (char_length(object_key) > 0 AND octet_length(object_key) <= 2048);
-- No service wrote originals before this step, but fixture rows may exist and
-- originals are immutable, so the rule binds every new row without a scan. A
-- stored original without a key reads as missing bytes.
ALTER TABLE original_objects ADD CONSTRAINT original_objects_object_key
  CHECK (reference_only = (object_key IS NULL)) NOT VALID;
-- Two originals never share stored bytes.
CREATE UNIQUE INDEX original_objects_key ON original_objects(space_id, object_key) WHERE object_key IS NOT NULL;
