-- Keep an indexed presence row for each declared field, including absent values.
-- This lets ascending sort pages find the first missing rows without scanning
-- the entire collection to prove that no missing row exists.
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

-- The migration runs before the new writer can serve traffic. Only ready
-- declarations are queried; incomplete declarations continue their backfill.
INSERT INTO record_index_values(space_id,collection_id,record_id,field_name,value_kind)
SELECT r.space_id,r.collection_id,r.record_id,d.field_name,'missing'
FROM collection_index_declarations d
JOIN records r ON r.space_id=d.space_id AND r.collection_id=d.collection_id AND NOT r.tombstone
WHERE d.ready AND NOT EXISTS (
  SELECT 1 FROM record_index_values v WHERE v.space_id=r.space_id AND v.collection_id=r.collection_id
    AND v.record_id=r.record_id AND v.field_name=d.field_name
);
