-- Keep an indexed presence row for each declared field, including absent values.
-- This lets ascending sort pages find the first missing rows without scanning
-- the entire collection to prove that no missing row exists.
-- Fence old record writers before checking historical completeness. The lock
-- waits for their transactions and remains held until the deferred trigger
-- exists, so no gap can commit between the sweep and cutover.
LOCK TABLE public.records IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE record_index_values DROP CONSTRAINT record_index_values_value_kind_check;
ALTER TABLE record_index_values DROP CONSTRAINT record_index_values_check;
ALTER TABLE record_index_values ADD CONSTRAINT record_index_values_value_kind_check
  CHECK (value_kind IN ('missing', 'null', 'string', 'number', 'boolean', 'date-time'));
ALTER TABLE record_index_values ADD CONSTRAINT record_index_values_check
  CHECK ((value_kind IN ('missing','null') AND num_nonnulls(string_value,number_value,boolean_value,time_value) = 0)
    OR (value_kind = 'string' AND string_value IS NOT NULL AND num_nonnulls(string_value,number_value,boolean_value,time_value) = 1)
    OR (value_kind = 'number' AND number_value IS NOT NULL AND num_nonnulls(string_value,number_value,boolean_value,time_value) = 1)
    OR (value_kind = 'boolean' AND boolean_value IS NOT NULL AND num_nonnulls(string_value,number_value,boolean_value,time_value) = 1)
    OR (value_kind = 'date-time' AND time_value IS NOT NULL AND num_nonnulls(string_value,number_value,boolean_value,time_value) = 1));
CREATE INDEX record_index_missing ON record_index_values(space_id, collection_id, field_name, record_id)
  WHERE value_kind = 'missing';

-- A gap might be a present value omitted by an older writer. Never invent a
-- missing value for it. Restart every incomplete backfill from the beginning;
-- downgrade a ready declaration with any gap before it can be queried again.
UPDATE collection_index_declarations d SET
  ready = d.ready AND NOT EXISTS (
    SELECT 1 FROM records r WHERE r.space_id=d.space_id AND r.collection_id=d.collection_id
      AND NOT r.tombstone AND NOT EXISTS (
        SELECT 1 FROM record_index_values v WHERE v.space_id=r.space_id AND v.collection_id=r.collection_id
          AND v.record_id=r.record_id AND v.field_name=d.field_name)),
  backfill_after = NULL;

-- A writer from before this migration can still run during a rolling cutover.
-- Reject its transaction at COMMIT if it omitted any declared projection.
-- The deferred check allows a new writer to replace a record and its rows in
-- either order within the same transaction. It also protects pending fields
-- from writes behind the backfill cursor.
CREATE FUNCTION stateplane_check_index_projection() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  p_space text;
  p_collection text;
  p_record text;
BEGIN
  IF TG_TABLE_NAME = 'records' THEN
    p_space := NEW.space_id;
    p_collection := NEW.collection_id;
    p_record := NEW.record_id;
  ELSE
    p_space := OLD.space_id;
    p_collection := OLD.collection_id;
    p_record := OLD.record_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.records r
    JOIN public.collection_index_declarations d ON d.space_id=r.space_id AND d.collection_id=r.collection_id
    LEFT JOIN public.record_index_values v ON v.space_id=r.space_id AND v.collection_id=r.collection_id
      AND v.record_id=r.record_id AND v.field_name=d.field_name
    WHERE r.space_id=p_space AND r.collection_id=p_collection AND r.record_id=p_record
      AND NOT r.tombstone AND v.record_id IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE='PZ003', MESSAGE='record index projection incomplete';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION stateplane_check_index_projection() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER record_index_projection_write
  AFTER INSERT OR UPDATE OF canonical_data,tombstone ON records DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stateplane_check_index_projection();
CREATE CONSTRAINT TRIGGER record_index_projection_delete
  AFTER DELETE ON record_index_values DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stateplane_check_index_projection();
