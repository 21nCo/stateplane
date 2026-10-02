-- UTC instants need full fractional precision and an explicit leap second.
-- timestamptz rounds to microseconds and cannot preserve either contract edge.
-- Remove Z and trailing fractional zeroes before bytewise comparison, leaving
-- an integral second as a prefix of every positive fraction in that second.
CREATE FUNCTION stateplane_instant_sort_key(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN strpos(value, '.') > 0
      THEN rtrim(rtrim(left(value, length(value) - 1), '0'), '.')
      ELSE left(value, length(value) - 1) END
  $$;

CREATE INDEX record_index_instant_order ON record_index_values
  (space_id, collection_id, field_name, (stateplane_instant_sort_key(time_value) COLLATE "C"), record_id)
  WHERE value_kind = 'date-time';
