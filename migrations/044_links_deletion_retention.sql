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

-- STA-36: every credentialed evidence mutation commits only while its key may
-- make it, as migration 043 does for claim revisions. The service checks each
-- grant in its last statement, but COMMIT is a separate round trip, so a key
-- or grant could lapse in between. Each request event names its credential:
-- a source deletion needs `sources:write` and `sources:read` on the source's
-- collection; a claim deletion `claims:write` and `claims:read` there and
-- `sources:read` on every collection the claim cites; a link creation or
-- deletion the read and write capability of each endpoint's kind on that
-- endpoint's collection, and `sources:read` on every collection a claim
-- endpoint cites. A refused COMMIT rolls back the tombstones, events, outbox
-- entries and erasure requests together, so no byte removal starts. An owner
-- session names no regional key; its provider decides that session, as
-- before. `detach` events name no credential and need none.
CREATE FUNCTION stateplane_check_evidence_authority() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  checked_at timestamptz := clock_timestamp();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.space_credentials WHERE space_id = NEW.space_id AND credential_id = NEW.credential_id) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    WITH live AS (SELECT g.collection_id, g.capabilities FROM public.space_credentials sc
      JOIN public.spaces s ON s.space_id = sc.space_id AND s.owner_principal_id = sc.owner_principal_id
      JOIN public.collection_grants g ON g.space_id = sc.space_id AND g.credential_id = sc.credential_id
      JOIN public.collections c ON c.space_id = g.space_id AND c.collection_id = g.collection_id
      WHERE sc.space_id = NEW.space_id AND sc.credential_id = NEW.credential_id AND c.lifecycle <> 'deleted'
        AND sc.activated_at IS NOT NULL AND sc.confirmed_at IS NOT NULL AND sc.revoked_at IS NULL AND sc.expires_at > checked_at
        AND (g.expires_at IS NULL OR g.expires_at > checked_at)),
    endpoint(kind, collection_id, id) AS (
      SELECT NEW.kind, NEW.collection_id, NEW.entity_id WHERE NEW.kind <> 'link'
      UNION ALL
      SELECT e.kind, e.collection_id, e.id FROM public.links l
        CROSS JOIN LATERAL (VALUES (l.from_kind, l.from_collection_id, l.from_id), (l.to_kind, l.to_collection_id, l.to_id))
          AS e(kind, collection_id, id)
        WHERE NEW.kind = 'link' AND l.space_id = NEW.space_id AND l.collection_id = NEW.collection_id AND l.link_id = NEW.entity_id),
    needed(collection_id, capability) AS (
      SELECT e.collection_id, e.kind || 's:' || n.verb FROM endpoint e CROSS JOIN (VALUES ('read'), ('write')) AS n(verb)
      UNION ALL
      SELECT a.source_collection_id, 'sources:read' FROM endpoint e JOIN public.claim_evidence a ON e.kind = 'claim'
        AND a.space_id = NEW.space_id AND a.collection_id = e.collection_id AND a.claim_id = e.id)
    SELECT 1 FROM needed WHERE NOT EXISTS (SELECT 1 FROM live
      WHERE live.collection_id = needed.collection_id AND needed.capability = ANY(live.capabilities))
    UNION ALL
    -- A link event whose link is missing proves nothing; refuse it rather than pass with no requirement.
    SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM endpoint)) THEN
    RAISE EXCEPTION 'evidence mutation''s key lost the grants it needs before COMMIT'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'evidence_events_authority';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_check_evidence_authority() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER evidence_events_authority AFTER INSERT ON evidence_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.credential_id IS NOT NULL)
  EXECUTE FUNCTION stateplane_check_evidence_authority();

-- A deleted source's stored original is erased from the blob store. The row
-- is queued by the tombstoning statement itself, so no deletion path can skip
-- it. `writers_end_at` is when the last grant that could write the key ended;
-- a write started before it can still land, so removal is recorded complete
-- only by a removal that starts after it plus the reconciliation grace, and
-- the sweep reopens a completed erasure whose key it finds again.
-- `next_attempt_at` orders retries: a failed or unsettled erasure moves behind
-- the others, so it cannot hold the oldest page.
CREATE TABLE original_erasures (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  source_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  writers_end_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at timestamptz,
  PRIMARY KEY (space_id, collection_id, source_id),
  FOREIGN KEY (space_id, collection_id, source_id) REFERENCES sources(space_id, collection_id, source_id),
  CHECK (removed_at IS NULL OR removed_at >= requested_at)
);
CREATE INDEX original_erasures_pending ON original_erasures(next_attempt_at, space_id, collection_id, source_id)
  WHERE removed_at IS NULL;

-- A space's erasure of its blob-store bytes, requested by every purge. It
-- outlives the purge like the `spaces` row, so erasure can be reported after.
-- `writers_end_at` is when the space's last upload grant ended (the purge,
-- when it had none); completion needs an empty listing that starts after it
-- plus the grace.
CREATE TABLE space_erasures (
  space_id text PRIMARY KEY REFERENCES spaces(space_id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  writers_end_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  originals_removed_at timestamptz,
  CHECK (originals_removed_at IS NULL OR originals_removed_at >= requested_at)
);
CREATE INDEX space_erasures_pending ON space_erasures(next_attempt_at, space_id) WHERE originals_removed_at IS NULL;

-- An erasure's identity never changes. Completion and its reopening by the
-- sweep, and retry scheduling, are its only changes; a purge may request a
-- space's erasure again, never earlier, and completion is recorded only
-- against the request that the completing listing saw.
CREATE FUNCTION stateplane_guard_erasure() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'original_erasures' THEN
    IF (to_jsonb(NEW) - 'removed_at' - 'next_attempt_at') = (to_jsonb(OLD) - 'removed_at' - 'next_attempt_at') THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.space_id = OLD.space_id AND NEW.requested_at >= OLD.requested_at AND NEW.writers_end_at >= OLD.writers_end_at
      AND (NEW.originals_removed_at IS NULL OR OLD.originals_removed_at IS NOT NULL OR NEW.requested_at = OLD.requested_at) THEN
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

-- Spaces deleted before this migration never requested erasure of their
-- bytes; request it now, so `erase` lists them and their report can complete.
-- Their grants are gone with the purge, so their writers ended no later than now.
INSERT INTO space_erasures(space_id) SELECT space_id FROM spaces WHERE lifecycle = 'deleted'
  ON CONFLICT (space_id) DO NOTHING;

CREATE FUNCTION stateplane_queue_original_erasure() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Only the grant that committed the source wrote its key.
  INSERT INTO public.original_erasures(space_id, collection_id, source_id, writers_end_at)
    SELECT o.space_id, o.collection_id, o.source_id, COALESCE(
      (SELECT max(g.expires_at) FROM public.source_upload_grants g WHERE g.space_id = o.space_id
        AND g.collection_id = o.collection_id AND g.source_id = o.source_id), clock_timestamp())
    FROM public.original_objects o
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
DECLARE
  writers_end timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.spaces WHERE space_id=p_space_id AND lifecycle='deleting' FOR UPDATE) THEN
    RAISE EXCEPTION 'space is not deleting';
  END IF;
  -- An upload grant can still write the space's keys until it ends, after its rows are gone.
  SELECT COALESCE(max(expires_at), clock_timestamp()) INTO writers_end FROM public.source_upload_grants WHERE space_id=p_space_id;
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
  INSERT INTO public.space_erasures(space_id, writers_end_at) VALUES (p_space_id, writers_end)
    ON CONFLICT (space_id) DO UPDATE SET requested_at = clock_timestamp(), originals_removed_at = NULL,
      writers_end_at = greatest(space_erasures.writers_end_at, EXCLUDED.writers_end_at), next_attempt_at = clock_timestamp();
  UPDATE public.spaces SET lifecycle='deleted',policy_version=policy_version+1 WHERE space_id=p_space_id;
END;
$$;
