CREATE TABLE collection_write_slots (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 8),
  PRIMARY KEY (space_id,collection_id,slot),
  FOREIGN KEY (space_id,collection_id) REFERENCES collections(space_id,collection_id) ON DELETE CASCADE
);
INSERT INTO collection_write_slots(space_id,collection_id,slot)
  SELECT c.space_id,c.collection_id,s.slot FROM collections c CROSS JOIN generate_series(1,8) AS s(slot);

CREATE FUNCTION stateplane_seed_write_slots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.collection_write_slots(space_id,collection_id,slot)
    SELECT NEW.space_id,NEW.collection_id,generate_series(1,8);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_seed_write_slots() FROM PUBLIC;
CREATE TRIGGER collection_write_slots_seed AFTER INSERT ON collections
  FOR EACH ROW EXECUTE FUNCTION stateplane_seed_write_slots();

CREATE TABLE batch_operations (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  credential_id text NOT NULL,
  operation_key text NOT NULL,
  manifest_digest text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','cancelled')),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id,collection_id,credential_id,operation_key),
  FOREIGN KEY (space_id,collection_id) REFERENCES collections(space_id,collection_id)
);

CREATE TABLE batch_items (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  credential_id text NOT NULL,
  operation_key text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 19),
  request_text text NOT NULL CHECK (octet_length(request_text)<=1048576),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','failed','succeeded')),
  failure_code text,
  receipt_id text,
  receipt jsonb,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (space_id,collection_id,credential_id,operation_key,ordinal),
  FOREIGN KEY (space_id,collection_id,credential_id,operation_key)
    REFERENCES batch_operations(space_id,collection_id,credential_id,operation_key) ON DELETE CASCADE
);
CREATE UNIQUE INDEX batch_items_receipt ON batch_items(receipt_id) WHERE receipt_id IS NOT NULL;

-- Space erasure must remove the batch ledger before collection rows.
CREATE OR REPLACE FUNCTION stateplane_purge_space(p_space_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.spaces WHERE space_id=p_space_id AND lifecycle='deleting' FOR UPDATE) THEN
    RAISE EXCEPTION 'space is not deleting';
  END IF;
  PERFORM set_config('stateplane.erasing_space', p_space_id, true);
  DELETE FROM public.batch_operations WHERE space_id=p_space_id;
  DELETE FROM public.projection_outbox WHERE space_id=p_space_id;
  DELETE FROM public.receipt_reservation_scopes WHERE space_id=p_space_id;
  DELETE FROM public.receipt_reservations WHERE space_id=p_space_id;
  DELETE FROM public.idempotency_receipts WHERE space_id=p_space_id;
  DELETE FROM public.record_tombstones WHERE space_id=p_space_id;
  DELETE FROM public.record_unique_keys WHERE space_id=p_space_id;
  DELETE FROM public.record_index_values WHERE space_id=p_space_id;
  DELETE FROM public.record_events WHERE space_id=p_space_id;
  DELETE FROM public.records WHERE space_id=p_space_id;
  DELETE FROM public.entity_refs WHERE space_id=p_space_id;
  DELETE FROM public.collection_grants WHERE space_id=p_space_id;
  DELETE FROM public.collection_unique_declarations WHERE space_id=p_space_id;
  DELETE FROM public.collection_index_declarations WHERE space_id=p_space_id;
  DELETE FROM public.collection_versions WHERE space_id=p_space_id;
  DELETE FROM public.collections WHERE space_id=p_space_id;
  DELETE FROM public.space_credentials WHERE space_id=p_space_id;
  DELETE FROM public.routing_nonces WHERE space_id=p_space_id;
  UPDATE public.spaces SET lifecycle='deleted',policy_version=policy_version+1 WHERE space_id=p_space_id;
END;
$$;
