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
-- An attempt becomes verified, or commits with its grant's source, only in a
-- transaction that commits before the grant expires. The check runs at COMMIT,
-- after the service's last authority statement, so no wait before COMMIT can
-- carry either transition past expiry; a refused COMMIT rolls back both.
CREATE FUNCTION stateplane_check_upload_expiry() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.source_upload_grants g WHERE g.space_id = NEW.space_id
      AND g.collection_id = NEW.collection_id AND g.grant_id = NEW.grant_id AND g.expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'upload grant expired before the attempt''s transition committed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'source_upload_attempts_expiry';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_check_upload_expiry() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER source_upload_attempts_expiry AFTER UPDATE OF state ON source_upload_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.state IN ('verified', 'committed') AND NEW.state IS DISTINCT FROM OLD.state)
  EXECUTE FUNCTION stateplane_check_upload_expiry();
