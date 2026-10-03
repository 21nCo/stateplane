-- Only the table owner, while the scoped SECURITY DEFINER erasure routine is
-- running, may remove immutable facts. Ordinary operational DML still fails.
CREATE OR REPLACE FUNCTION reject_record_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = pg_get_userbyid(
      (SELECT relowner FROM pg_class WHERE oid = 'public.record_events'::regclass))
    AND current_setting('stateplane.erasing_space', true) = OLD.space_id THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'record events are immutable';
END;
$$;
REVOKE ALL ON FUNCTION reject_record_event_change() FROM PUBLIC;

CREATE OR REPLACE FUNCTION reject_authority_fact_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'collection_versions'
    AND current_user = pg_get_userbyid(
      (SELECT relowner FROM pg_class WHERE oid = 'public.collection_versions'::regclass))
    AND current_setting('stateplane.erasing_space', true) = OLD.space_id THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'accepted authority facts are immutable';
END;
$$;
REVOKE ALL ON FUNCTION reject_authority_fact_update() FROM PUBLIC;

CREATE FUNCTION stateplane_purge_space(p_space_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.spaces WHERE space_id=p_space_id AND lifecycle='deleting' FOR UPDATE) THEN
    RAISE EXCEPTION 'space is not deleting';
  END IF;
  PERFORM set_config('stateplane.erasing_space', p_space_id, true);
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
REVOKE ALL ON FUNCTION stateplane_purge_space(text) FROM PUBLIC;
