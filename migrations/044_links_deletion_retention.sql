-- STA-36: links, deletion of sources, claims and links, and retention of
-- original bytes. Every lifecycle change of a link, and every deletion of a
-- source or claim, is an immutable evidence event, and each event enqueues
-- one projection invalidation for its collection in the same transaction.

CREATE TABLE evidence_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^eev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  space_id text NOT NULL,
  collection_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('source', 'claim', 'link')),
  entity_id text NOT NULL CHECK (char_length(entity_id) > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  -- `detach`: the database tombstoned the link because one of its endpoints
  -- was deleted. No credential asked for it, so none is recorded.
  operation text NOT NULL CHECK (operation IN ('create', 'delete', 'detach')),
  credential_id text CHECK (credential_id IS NULL OR char_length(credential_id) > 0),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id),
  UNIQUE (space_id, collection_id, kind, entity_id, revision),
  CHECK (kind = 'link' OR operation = 'delete'),
  CHECK ((operation = 'detach') = (credential_id IS NULL))
);

-- One pending invalidation per event, under the placement generation current
-- when it committed. Delivery fields are the only mutable columns.
CREATE TABLE evidence_outbox (
  event_id text PRIMARY KEY REFERENCES evidence_events(event_id),
  space_id text NOT NULL,
  collection_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  delivery_state text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'delivered')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  CHECK ((delivery_state = 'delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX evidence_outbox_pending ON evidence_outbox(space_id, collection_id, available_at, event_id)
  WHERE delivery_state = 'pending';

CREATE TRIGGER evidence_events_immutable BEFORE UPDATE OR DELETE ON evidence_events
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER evidence_events_no_truncate BEFORE TRUNCATE ON evidence_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER evidence_outbox_kept BEFORE DELETE ON evidence_outbox
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER evidence_outbox_no_truncate BEFORE TRUNCATE ON evidence_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_fact_change();

-- Owner rights let a writer record an event without outbox privileges.
CREATE FUNCTION stateplane_enqueue_evidence_event() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public.evidence_outbox(event_id, space_id, collection_id, generation)
    SELECT NEW.event_id, NEW.space_id, NEW.collection_id, s.placement_generation
    FROM public.spaces s WHERE s.space_id = NEW.space_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_enqueue_evidence_event() FROM PUBLIC;
CREATE TRIGGER evidence_events_outbox AFTER INSERT ON evidence_events
  FOR EACH ROW EXECUTE FUNCTION stateplane_enqueue_evidence_event();

-- Tombstoning an endpoint fails with restrict_violation while a live
-- `restrict` link touches it. Otherwise every live `detach` link touching it
-- is tombstoned by the same statement, with a `detach` event and its outbox
-- entry. The endpoint's row lock is held from the tombstoning update, so a
-- link that commits after it waits and then refuses the deleted endpoint, and
-- one committed earlier is seen here (READ COMMITTED) or makes the update
-- fail with 40001 (a snapshot that predates it). Mixed policies reject the
-- whole deletion, detach links included.
CREATE OR REPLACE FUNCTION stateplane_guard_endpoint_tombstone() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  endpoint_kind text;
  endpoint_id text;
BEGIN
  IF TG_TABLE_NAME = 'records' THEN
    endpoint_kind := 'record';
    endpoint_id := NEW.record_id;
  ELSE
    endpoint_kind := NEW.kind;
    endpoint_id := NEW.entity_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.links l WHERE l.space_id = NEW.space_id AND NOT l.tombstone
      AND l.deletion_policy = 'restrict'
      AND ((l.from_collection_id = NEW.collection_id AND l.from_kind = endpoint_kind AND l.from_id = endpoint_id)
        OR (l.to_collection_id = NEW.collection_id AND l.to_kind = endpoint_kind AND l.to_id = endpoint_id))) THEN
    RAISE EXCEPTION 'a live restrict link blocks endpoint deletion'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'links_restrict';
  END IF;
  WITH detached AS (
    UPDATE public.links l SET revision = l.revision + 1, tombstone = true, tombstoned_at = clock_timestamp()
    WHERE l.space_id = NEW.space_id AND NOT l.tombstone
      AND ((l.from_collection_id = NEW.collection_id AND l.from_kind = endpoint_kind AND l.from_id = endpoint_id)
        OR (l.to_collection_id = NEW.collection_id AND l.to_kind = endpoint_kind AND l.to_id = endpoint_id))
    RETURNING l.collection_id, l.link_id, l.revision)
  INSERT INTO public.evidence_events(event_id, space_id, collection_id, kind, entity_id, revision, operation)
    SELECT 'eev_' || gen_random_uuid(), NEW.space_id, d.collection_id, 'link', d.link_id, d.revision, 'detach'
    FROM detached d;
  RETURN NULL;
END;
$$;

-- A deleted source's stored original is erased from the blob store. The row
-- is queued by the tombstoning statement itself, so no deletion path can skip
-- it; the reconciler removes the bytes and records when the store confirmed.
CREATE TABLE original_erasures (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  source_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at timestamptz,
  PRIMARY KEY (space_id, collection_id, source_id),
  FOREIGN KEY (space_id, collection_id, source_id) REFERENCES sources(space_id, collection_id, source_id),
  CHECK (removed_at IS NULL OR removed_at >= requested_at)
);
CREATE INDEX original_erasures_pending ON original_erasures(requested_at, space_id, collection_id, source_id)
  WHERE removed_at IS NULL;

-- A space's erasure of its blob-store bytes, requested by every purge. It
-- outlives the purge like the `spaces` row, so erasure can be reported after.
CREATE TABLE space_erasures (
  space_id text PRIMARY KEY REFERENCES spaces(space_id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  originals_removed_at timestamptz,
  CHECK (originals_removed_at IS NULL OR originals_removed_at >= requested_at)
);
CREATE INDEX space_erasures_pending ON space_erasures(requested_at, space_id) WHERE originals_removed_at IS NULL;

-- Erasure rows only record completion, once; a purge may request it again.
CREATE FUNCTION stateplane_guard_erasure() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'original_erasures' THEN
    IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL
      AND (to_jsonb(NEW) - 'removed_at') = (to_jsonb(OLD) - 'removed_at') THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.space_id = OLD.space_id AND ((OLD.originals_removed_at IS NULL AND NEW.originals_removed_at IS NOT NULL
      AND NEW.requested_at = OLD.requested_at) OR (NEW.originals_removed_at IS NULL AND NEW.requested_at >= OLD.requested_at)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'erasure progress only moves forward' USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_transition';
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_erasure() FROM PUBLIC;
CREATE TRIGGER original_erasures_transition BEFORE UPDATE ON original_erasures
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_erasure();
CREATE TRIGGER space_erasures_transition BEFORE UPDATE ON space_erasures
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_erasure();
CREATE TRIGGER original_erasures_kept BEFORE DELETE ON original_erasures
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER original_erasures_no_truncate BEFORE TRUNCATE ON original_erasures
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER space_erasures_kept BEFORE DELETE ON space_erasures
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();

CREATE FUNCTION stateplane_queue_original_erasure() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public.original_erasures(space_id, collection_id, source_id)
    SELECT o.space_id, o.collection_id, o.source_id FROM public.original_objects o
    WHERE o.space_id = NEW.space_id AND o.collection_id = NEW.collection_id AND o.source_id = NEW.entity_id
      AND o.object_key IS NOT NULL
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_queue_original_erasure() FROM PUBLIC;
CREATE TRIGGER entity_refs_original_erasure AFTER UPDATE OF tombstone ON entity_refs
  FOR EACH ROW WHEN (NEW.kind = 'source' AND NEW.tombstone AND NOT OLD.tombstone)
  EXECUTE FUNCTION stateplane_queue_original_erasure();

-- Space erasure removes evidence before the records and identities it cites,
-- and requests erasure of the space's blob-store bytes, which are outside
-- this transaction.
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
  DELETE FROM public.projection_reconciliations WHERE space_id=p_space_id;
  DELETE FROM public.projection_heads WHERE space_id=p_space_id;
  DELETE FROM public.outbox_space_rotation WHERE space_id=p_space_id;
  DELETE FROM public.projection_outbox WHERE space_id=p_space_id;
  DELETE FROM public.receipt_reservation_scopes WHERE space_id=p_space_id;
  DELETE FROM public.receipt_reservations WHERE space_id=p_space_id;
  DELETE FROM public.idempotency_receipts WHERE space_id=p_space_id;
  DELETE FROM public.evidence_outbox WHERE space_id=p_space_id;
  DELETE FROM public.evidence_events WHERE space_id=p_space_id;
  DELETE FROM public.original_erasures WHERE space_id=p_space_id;
  DELETE FROM public.links WHERE space_id=p_space_id;
  DELETE FROM public.claim_evidence WHERE space_id=p_space_id;
  DELETE FROM public.claim_revisions WHERE space_id=p_space_id;
  DELETE FROM public.claims WHERE space_id=p_space_id;
  DELETE FROM public.source_upload_attempts WHERE space_id=p_space_id;
  DELETE FROM public.source_upload_grants WHERE space_id=p_space_id;
  DELETE FROM public.extraction_versions WHERE space_id=p_space_id;
  DELETE FROM public.original_objects WHERE space_id=p_space_id;
  DELETE FROM public.sources WHERE space_id=p_space_id;
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
  -- Every purge asks again, so a repaired erasure lists the space's keys anew.
  INSERT INTO public.space_erasures(space_id) VALUES (p_space_id)
    ON CONFLICT (space_id) DO UPDATE SET requested_at = clock_timestamp(), originals_removed_at = NULL;
  UPDATE public.spaces SET lifecycle='deleted',policy_version=policy_version+1 WHERE space_id=p_space_id;
END;
$$;
