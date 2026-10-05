-- Keep historical raw external keys in the same v1 identity namespace as
-- newly normalized keys. A nonunique index preserves preexisting collisions
-- so reads can report them explicitly instead of choosing a spelling winner.
CREATE FUNCTION public.stateplane_external_key_identity(raw text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT pg_catalog.btrim(normalize(raw, NFC),
    pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(11) ||
    pg_catalog.chr(12) || pg_catalog.chr(13) || pg_catalog.chr(32) ||
    pg_catalog.chr(133) || pg_catalog.chr(160) || pg_catalog.chr(5760) ||
    pg_catalog.chr(8192) || pg_catalog.chr(8193) || pg_catalog.chr(8194) ||
    pg_catalog.chr(8195) || pg_catalog.chr(8196) || pg_catalog.chr(8197) ||
    pg_catalog.chr(8198) || pg_catalog.chr(8199) || pg_catalog.chr(8200) ||
    pg_catalog.chr(8201) || pg_catalog.chr(8202) || pg_catalog.chr(8232) ||
    pg_catalog.chr(8233) || pg_catalog.chr(8239) || pg_catalog.chr(8287) ||
    pg_catalog.chr(12288))
$$;

CREATE INDEX records_external_key_identity_idx
  ON records (space_id, collection_id, public.stateplane_external_key_identity(normalized_key))
  WHERE key_mode='external';
