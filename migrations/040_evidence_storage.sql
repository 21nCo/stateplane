-- STA-13 evidence storage: sources, immutable originals, upload grants and
-- attempts, extraction versions, claims and typed links. Every row carries its
-- space and owning collection, and every key path ends at `collections`.
-- `entity_refs` (migration 002) stays the canonical source/claim identity with
-- its revision and tombstone; the tables below hold payload and history.
--
-- Take the locks this step needs up front, in record writers' order. New
-- tables are empty, so nothing is scanned; the migrator bounds the wait.
LOCK TABLE collections, records, entity_refs IN SHARE ROW EXCLUSIVE MODE;

-- Lowercase RFC 6838 type/subtype essence, without parameters.
CREATE DOMAIN stateplane_mime_type AS text
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$');
CREATE DOMAIN stateplane_sha256 AS text CHECK (VALUE ~ '^[0-9a-f]{64}$');

CREATE TABLE sources (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  source_id text NOT NULL CHECK (char_length(source_id) > 0),
  kind text NOT NULL GENERATED ALWAYS AS ('source') STORED,
  -- Caller-declared locator such as a URL. It is never proof of fetched bytes.
  locator text CHECK (char_length(locator) > 0 AND octet_length(locator) <= 4096),
  principal_id text NOT NULL CHECK (char_length(principal_id) > 0),
  credential_id text NOT NULL CHECK (char_length(credential_id) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, source_id),
  FOREIGN KEY (space_id, collection_id, kind, source_id)
    REFERENCES entity_refs(space_id, collection_id, kind, entity_id)
);

-- One immutable original per source: verified bytes, or an explicit
-- reference-only marker that discloses no bytes were fetched. The blob store
-- addresses bytes by (space, sha256) in the space's storage target.
CREATE TABLE original_objects (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  source_id text NOT NULL,
  reference_only boolean NOT NULL,
  sha256 stateplane_sha256,
  byte_size bigint CHECK (byte_size >= 0),
  mime_type stateplane_mime_type,
  captured_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, source_id),
  -- Extraction versions cite the exact digest they were parsed from.
  UNIQUE (space_id, collection_id, source_id, sha256),
  FOREIGN KEY (space_id, collection_id, source_id) REFERENCES sources(space_id, collection_id, source_id),
  CHECK (reference_only = (sha256 IS NULL)),
  CHECK ((sha256 IS NULL) = (byte_size IS NULL)),
  CHECK (reference_only OR mime_type IS NOT NULL),
  CHECK (captured_at <= observed_at)
);
-- Blob removal must find every original in the space sharing a digest.
CREATE INDEX original_objects_digest ON original_objects(space_id, sha256) WHERE sha256 IS NOT NULL;
-- A committed source always has its original, inserted in the same transaction.
ALTER TABLE sources ADD CONSTRAINT sources_original
  FOREIGN KEY (space_id, collection_id, source_id)
  REFERENCES original_objects(space_id, collection_id, source_id)
  DEFERRABLE INITIALLY DEFERRED;

-- A short-lived grant binds actor, collection and content constraints. Finalize
-- records the committed source; revocation and finalization are exclusive.
CREATE TABLE source_upload_grants (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  grant_id text NOT NULL CHECK (char_length(grant_id) > 0),
  principal_id text NOT NULL CHECK (char_length(principal_id) > 0),
  credential_id text NOT NULL CHECK (char_length(credential_id) > 0),
  mime_type stateplane_mime_type NOT NULL,
  max_bytes bigint NOT NULL CHECK (max_bytes > 0),
  expected_sha256 stateplane_sha256,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  finalized_at timestamptz,
  source_id text,
  PRIMARY KEY (space_id, collection_id, grant_id),
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id),
  FOREIGN KEY (space_id, collection_id, source_id) REFERENCES sources(space_id, collection_id, source_id),
  CHECK (expires_at > issued_at),
  CHECK ((finalized_at IS NULL) = (source_id IS NULL)),
  CHECK (revoked_at IS NULL OR finalized_at IS NULL)
);

-- Each upload attempt names its staging blob, so reconciliation can remove
-- orphaned or partially finalized bytes and record that it did.
CREATE TABLE source_upload_attempts (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  grant_id text NOT NULL,
  attempt_id text NOT NULL CHECK (char_length(attempt_id) > 0),
  staging_key text NOT NULL CHECK (char_length(staging_key) > 0 AND octet_length(staging_key) <= 1024),
  state text NOT NULL DEFAULT 'receiving' CHECK (state IN ('receiving', 'verified', 'committed', 'failed')),
  observed_sha256 stateplane_sha256,
  observed_bytes bigint CHECK (observed_bytes >= 0),
  observed_mime_type stateplane_mime_type,
  failure_code text CHECK (char_length(failure_code) > 0 AND octet_length(failure_code) <= 64),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  staging_removed_at timestamptz,
  PRIMARY KEY (space_id, collection_id, grant_id, attempt_id),
  FOREIGN KEY (space_id, collection_id, grant_id)
    REFERENCES source_upload_grants(space_id, collection_id, grant_id),
  -- Removing one attempt's staging blob can never delete another attempt's bytes.
  UNIQUE (space_id, staging_key),
  CHECK (state NOT IN ('verified', 'committed') OR (observed_sha256 IS NOT NULL AND observed_bytes IS NOT NULL)),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);
CREATE UNIQUE INDEX source_upload_attempts_committed
  ON source_upload_attempts(space_id, collection_id, grant_id) WHERE state = 'committed';
CREATE INDEX source_upload_attempts_staged
  ON source_upload_attempts(updated_at) WHERE staging_removed_at IS NULL;

-- A corrected extraction is a new version. Versions start at 1 without gaps,
-- and each cites the original digest; a reference-only source has none.
CREATE TABLE extraction_versions (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  source_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  previous_version bigint GENERATED ALWAYS AS (NULLIF(version - 1, 0)) STORED,
  source_sha256 stateplane_sha256 NOT NULL,
  parser text NOT NULL CHECK (char_length(parser) > 0 AND octet_length(parser) <= 256),
  parser_version text NOT NULL CHECK (char_length(parser_version) > 0 AND octet_length(parser_version) <= 256),
  content text NOT NULL CHECK (octet_length(content) <= 1048576),
  -- Parser-defined segments mapping content ranges to source positions.
  source_offsets jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(source_offsets) = 'array' AND octet_length(source_offsets::text) <= 1048576),
  credential_id text NOT NULL CHECK (char_length(credential_id) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, source_id, version),
  FOREIGN KEY (space_id, collection_id, source_id, source_sha256)
    REFERENCES original_objects(space_id, collection_id, source_id, sha256),
  FOREIGN KEY (space_id, collection_id, source_id, previous_version)
    REFERENCES extraction_versions(space_id, collection_id, source_id, version)
);

CREATE TABLE claims (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  claim_id text NOT NULL CHECK (char_length(claim_id) > 0),
  kind text NOT NULL GENERATED ALWAYS AS ('claim') STORED,
  principal_id text NOT NULL CHECK (char_length(principal_id) > 0),
  credential_id text NOT NULL CHECK (char_length(credential_id) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, claim_id),
  FOREIGN KEY (space_id, collection_id, kind, claim_id)
    REFERENCES entity_refs(space_id, collection_id, kind, entity_id)
);

-- Each revision is an immutable attributed assertion. Review produces a new
-- revision; `entity_refs.revision` names the current one.
CREATE TABLE claim_revisions (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  claim_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  previous_revision bigint GENERATED ALWAYS AS (NULLIF(revision - 1, 0)) STORED,
  statement text NOT NULL CHECK (char_length(statement) > 0 AND octet_length(statement) <= 1048576),
  attributed_to text NOT NULL CHECK (char_length(attributed_to) > 0 AND octet_length(attributed_to) <= 1024),
  credential_id text NOT NULL CHECK (char_length(credential_id) > 0),
  observed_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'accepted', 'rejected')),
  reviewed_by text CHECK (char_length(reviewed_by) > 0),
  reviewed_at timestamptz,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, claim_id, revision),
  FOREIGN KEY (space_id, collection_id, claim_id) REFERENCES claims(space_id, collection_id, claim_id),
  FOREIGN KEY (space_id, collection_id, claim_id, previous_revision)
    REFERENCES claim_revisions(space_id, collection_id, claim_id, revision),
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until),
  CHECK ((review_status = 'unreviewed') = (reviewed_by IS NULL)),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);

-- Evidence a claim revision cites: a source in the same space, optionally a
-- half-open content range of one extraction version. Citing grants no access.
CREATE TABLE claim_evidence (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  claim_id text NOT NULL,
  revision bigint NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  source_collection_id text NOT NULL,
  source_id text NOT NULL,
  extraction_version bigint,
  start_offset bigint,
  end_offset bigint,
  PRIMARY KEY (space_id, collection_id, claim_id, revision, ordinal),
  FOREIGN KEY (space_id, collection_id, claim_id, revision)
    REFERENCES claim_revisions(space_id, collection_id, claim_id, revision),
  FOREIGN KEY (space_id, source_collection_id, source_id) REFERENCES sources(space_id, collection_id, source_id),
  FOREIGN KEY (space_id, source_collection_id, source_id, extraction_version)
    REFERENCES extraction_versions(space_id, collection_id, source_id, version),
  CHECK ((start_offset IS NULL) = (end_offset IS NULL)),
  CHECK (start_offset IS NULL OR (extraction_version IS NOT NULL AND start_offset >= 0 AND start_offset <= end_offset))
);
CREATE INDEX claim_evidence_source ON claim_evidence(space_id, source_collection_id, source_id);

-- A typed link between two endpoints in one space, owned by one endpoint's
-- collection. Kind-specific generated columns give each endpoint a real
-- foreign key: records for `record`, entity_refs for `source` and `claim`.
CREATE TABLE links (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  link_id text NOT NULL CHECK (char_length(link_id) > 0),
  link_type text NOT NULL CHECK (char_length(link_type) > 0 AND octet_length(link_type) <= 256),
  deletion_policy text NOT NULL CHECK (deletion_policy IN ('restrict', 'detach')),
  from_kind text NOT NULL CHECK (from_kind IN ('record', 'source', 'claim')),
  from_collection_id text NOT NULL,
  from_id text NOT NULL CHECK (char_length(from_id) > 0),
  to_kind text NOT NULL CHECK (to_kind IN ('record', 'source', 'claim')),
  to_collection_id text NOT NULL,
  to_id text NOT NULL CHECK (char_length(to_id) > 0),
  from_record_id text GENERATED ALWAYS AS (CASE WHEN from_kind = 'record' THEN from_id END) STORED,
  from_entity_kind text GENERATED ALWAYS AS (CASE WHEN from_kind <> 'record' THEN from_kind END) STORED,
  from_entity_id text GENERATED ALWAYS AS (CASE WHEN from_kind <> 'record' THEN from_id END) STORED,
  to_record_id text GENERATED ALWAYS AS (CASE WHEN to_kind = 'record' THEN to_id END) STORED,
  to_entity_kind text GENERATED ALWAYS AS (CASE WHEN to_kind <> 'record' THEN to_kind END) STORED,
  to_entity_id text GENERATED ALWAYS AS (CASE WHEN to_kind <> 'record' THEN to_id END) STORED,
  credential_id text NOT NULL CHECK (char_length(credential_id) > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  tombstone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  tombstoned_at timestamptz,
  PRIMARY KEY (space_id, collection_id, link_id),
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id),
  FOREIGN KEY (space_id, from_collection_id, from_record_id) REFERENCES records(space_id, collection_id, record_id),
  FOREIGN KEY (space_id, from_collection_id, from_entity_kind, from_entity_id)
    REFERENCES entity_refs(space_id, collection_id, kind, entity_id),
  FOREIGN KEY (space_id, to_collection_id, to_record_id) REFERENCES records(space_id, collection_id, record_id),
  FOREIGN KEY (space_id, to_collection_id, to_entity_kind, to_entity_id)
    REFERENCES entity_refs(space_id, collection_id, kind, entity_id),
  CHECK (collection_id IN (from_collection_id, to_collection_id)),
  CHECK ((from_kind, from_collection_id, from_id) <> (to_kind, to_collection_id, to_id)),
  CHECK (tombstone = (tombstoned_at IS NOT NULL))
);
CREATE INDEX links_live_from ON links(space_id, from_collection_id, from_kind, from_id) WHERE NOT tombstone;
CREATE INDEX links_live_to ON links(space_id, to_collection_id, to_kind, to_id) WHERE NOT tombstone;


-- Source and claim provenance, originals, extraction versions and claim
-- history cannot be rewritten; lifecycle lives in `entity_refs`. Only
-- the table owner, inside the scoped SECURITY DEFINER erasure routine, may
-- delete one erasing space's rows; ordinary DML and TRUNCATE always fail.
CREATE FUNCTION reject_evidence_fact_change() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = pg_catalog.pg_get_userbyid(
        (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID))
      AND current_setting('stateplane.erasing_space', true) = OLD.space_id THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'evidence facts are immutable';
END;
$$;
REVOKE ALL ON FUNCTION reject_evidence_fact_change() FROM PUBLIC;
CREATE TRIGGER sources_immutable BEFORE UPDATE OR DELETE ON sources
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER sources_no_truncate BEFORE TRUNCATE ON sources
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER claims_immutable BEFORE UPDATE OR DELETE ON claims
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER claims_no_truncate BEFORE TRUNCATE ON claims
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER original_objects_immutable BEFORE UPDATE OR DELETE ON original_objects
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER original_objects_no_truncate BEFORE TRUNCATE ON original_objects
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER extraction_versions_immutable BEFORE UPDATE OR DELETE ON extraction_versions
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER extraction_versions_no_truncate BEFORE TRUNCATE ON extraction_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER claim_revisions_immutable BEFORE UPDATE OR DELETE ON claim_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER claim_revisions_no_truncate BEFORE TRUNCATE ON claim_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER claim_evidence_immutable BEFORE UPDATE OR DELETE ON claim_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER claim_evidence_no_truncate BEFORE TRUNCATE ON claim_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_fact_change();

-- A reference-only original discloses that no bytes were fetched, so its
-- source must say where the evidence lives. Sources are immutable and the
-- source row exists before its original, so checking at insert is final.
CREATE FUNCTION stateplane_check_reference_locator() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.reference_only AND EXISTS (SELECT 1 FROM public.sources WHERE space_id = NEW.space_id
      AND collection_id = NEW.collection_id AND source_id = NEW.source_id AND locator IS NULL) THEN
    RAISE EXCEPTION 'a reference-only source needs a locator'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'original_objects_reference_locator';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_check_reference_locator() FROM PUBLIC;
CREATE TRIGGER original_objects_reference_locator BEFORE INSERT ON original_objects
  FOR EACH ROW EXECUTE FUNCTION stateplane_check_reference_locator();

-- The upload ledger moves forward only. A grant's binding never changes; it
-- ends exactly once, revoked or finalized, and then stays as it is. An
-- attempt's staging key never changes, it never returns to `receiving`, and a
-- committed or failed attempt keeps its state and observations. Observed
-- digest, size, MIME type, failure code and staging removal are each set at
-- most once; only `updated_at` moves freely.
CREATE FUNCTION stateplane_guard_upload_ledger() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  set_once text[];
  name text;
BEGIN
  IF TG_TABLE_NAME = 'source_upload_grants' THEN
    set_once := ARRAY['revoked_at', 'finalized_at', 'source_id'];
    IF (OLD.revoked_at IS NOT NULL OR OLD.finalized_at IS NOT NULL) AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'a revoked or finalized upload grant is final'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'source_upload_grants_transition';
    END IF;
  ELSE
    -- A committed or failed attempt may still record its staging removal.
    set_once := CASE WHEN OLD.state IN ('committed', 'failed') THEN ARRAY['staging_removed_at']
      ELSE ARRAY['observed_sha256', 'observed_bytes', 'observed_mime_type', 'failure_code', 'staging_removed_at'] END;
    IF (OLD.state IN ('committed', 'failed') AND NEW.state <> OLD.state)
      OR (OLD.state = 'verified' AND NEW.state = 'receiving') THEN
      RAISE EXCEPTION 'upload attempt cannot move from % to %', OLD.state, NEW.state
        USING ERRCODE = 'check_violation', CONSTRAINT = 'source_upload_attempts_transition';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - set_once - 'state' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - set_once - 'state' - 'updated_at') THEN
    RAISE EXCEPTION '% binding columns are immutable', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_transition';
  END IF;
  FOREACH name IN ARRAY set_once LOOP
    IF to_jsonb(OLD) -> name <> 'null'::jsonb AND to_jsonb(NEW) -> name IS DISTINCT FROM to_jsonb(OLD) -> name THEN
      RAISE EXCEPTION '%.% is set at most once', TG_TABLE_NAME, name
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_transition';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_upload_ledger() FROM PUBLIC;
CREATE TRIGGER source_upload_grants_transition BEFORE UPDATE ON source_upload_grants
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_upload_ledger();
CREATE TRIGGER source_upload_attempts_transition BEFORE UPDATE ON source_upload_attempts
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_upload_ledger();

-- A link never changes its endpoints, type, policy or owner and is never
-- resurrected: the only update tombstones a live link at the next revision.
-- Like the facts above, links are removed only by space erasure. Generated
-- endpoint columns are not yet computed in NEW and follow the compared ones.
CREATE FUNCTION stateplane_guard_link_change() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  mutable text[] := ARRAY['revision','tombstone','tombstoned_at','from_record_id','from_entity_kind',
    'from_entity_id','to_record_id','to_entity_kind','to_entity_id'];
BEGIN
  IF OLD.tombstone OR NOT NEW.tombstone OR NEW.revision <> OLD.revision + 1
    OR (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'links change only by tombstoning';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_link_change() FROM PUBLIC;
CREATE TRIGGER links_tombstone_only BEFORE UPDATE ON links
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_link_change();
CREATE TRIGGER links_immutable BEFORE DELETE ON links
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_fact_change();
CREATE TRIGGER links_no_truncate BEFORE TRUNCATE ON links
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_fact_change();

-- No live link may reference a missing or tombstoned endpoint. A new link
-- rewrites both endpoint rows in place, a real write rather than a row lock,
-- so the endpoint's tombstone update and the link's creation conflict at every
-- isolation level. Under READ COMMITTED the later of the two waits and then
-- sees the other's commit; a REPEATABLE READ or SERIALIZABLE writer whose
-- snapshot predates the other's commit fails with 40001 instead. An endpoint
-- the rewrite cannot see is refused here rather than left to its foreign key,
-- which checks only existence and would accept an endpoint created and
-- tombstoned while this insert waited. Endpoints are rewritten in a fixed
-- order, so links created in opposite directions queue instead of
-- deadlocking. Owner rights let operational roles delete records without
-- link grants.
CREATE FUNCTION stateplane_guard_link_insert() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  endpoint record;
  deleted boolean;
BEGIN
  IF NEW.tombstone OR NEW.revision <> 1 THEN
    RAISE EXCEPTION 'links are created live at revision 1';
  END IF;
  FOR endpoint IN SELECT * FROM (VALUES (NEW.from_kind, NEW.from_collection_id, NEW.from_id),
      (NEW.to_kind, NEW.to_collection_id, NEW.to_id)) AS e(kind, collection_id, id)
      ORDER BY kind COLLATE "C", collection_id COLLATE "C", id COLLATE "C" LOOP
    -- The endpoint kind check rejects any other kind after this trigger.
    CONTINUE WHEN endpoint.kind NOT IN ('record', 'source', 'claim');
    -- `revision` is outside every column-specific trigger, so this rewrite
    -- changes no value and emits no record events. It does queue the
    -- deferred `entity_refs_payload` check, which the unchanged row passes.
    IF endpoint.kind = 'record' THEN
      UPDATE public.records SET revision = revision
        WHERE space_id = NEW.space_id AND collection_id = endpoint.collection_id AND record_id = endpoint.id
        RETURNING tombstone INTO deleted;
    ELSE
      UPDATE public.entity_refs SET revision = revision
        WHERE space_id = NEW.space_id AND collection_id = endpoint.collection_id
          AND kind = endpoint.kind AND entity_id = endpoint.id
        RETURNING tombstone INTO deleted;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'link endpoint does not exist' USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'links_live_endpoint';
    END IF;
    IF deleted THEN
      RAISE EXCEPTION 'link endpoint is deleted' USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'links_live_endpoint';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_link_insert() FROM PUBLIC;
CREATE TRIGGER links_live_endpoints BEFORE INSERT ON links
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_link_insert();

-- Tombstoning an endpoint fails with restrict_violation while a live
-- `restrict` link touches it, and with foreign_key_violation while a live
-- `detach` link does: the writer tombstones detach links first, with their
-- events, in the same transaction. A link committed after this transaction's
-- snapshot rewrote the endpoint row, so the tombstone update either waits and
-- rereads (READ COMMITTED) or fails with 40001 before reaching this check.
CREATE FUNCTION stateplane_guard_endpoint_tombstone() RETURNS trigger LANGUAGE plpgsql
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
  IF EXISTS (SELECT 1 FROM public.links l WHERE l.space_id = NEW.space_id AND NOT l.tombstone
      AND ((l.from_collection_id = NEW.collection_id AND l.from_kind = endpoint_kind AND l.from_id = endpoint_id)
        OR (l.to_collection_id = NEW.collection_id AND l.to_kind = endpoint_kind AND l.to_id = endpoint_id))) THEN
    RAISE EXCEPTION 'live detach links must be tombstoned with their endpoint'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'links_detach';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_endpoint_tombstone() FROM PUBLIC;
CREATE TRIGGER records_link_endpoint AFTER UPDATE OF tombstone ON records
  FOR EACH ROW WHEN (NEW.tombstone AND NOT OLD.tombstone)
  EXECUTE FUNCTION stateplane_guard_endpoint_tombstone();
CREATE TRIGGER entity_refs_link_endpoint AFTER UPDATE OF tombstone ON entity_refs
  FOR EACH ROW WHEN (NEW.tombstone AND NOT OLD.tombstone)
  EXECUTE FUNCTION stateplane_guard_endpoint_tombstone();

-- At commit, every source identity has its source row and every live claim's
-- current revision exists, so a reader never finds an identity without content.
CREATE FUNCTION stateplane_check_entity_payload() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_ref record;
BEGIN
  SELECT revision, tombstone INTO current_ref FROM public.entity_refs
    WHERE space_id = NEW.space_id AND collection_id = NEW.collection_id AND kind = NEW.kind AND entity_id = NEW.entity_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NEW.kind = 'source' AND NOT EXISTS (SELECT 1 FROM public.sources
      WHERE space_id = NEW.space_id AND collection_id = NEW.collection_id AND source_id = NEW.entity_id) THEN
    RAISE EXCEPTION 'source identity has no source row'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'entity_refs_payload';
  END IF;
  IF NEW.kind = 'claim' AND NOT current_ref.tombstone AND NOT EXISTS (SELECT 1 FROM public.claim_revisions
      WHERE space_id = NEW.space_id AND collection_id = NEW.collection_id AND claim_id = NEW.entity_id
        AND revision = current_ref.revision) THEN
    RAISE EXCEPTION 'live claim has no current revision'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'entity_refs_payload';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_check_entity_payload() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER entity_refs_payload AFTER INSERT OR UPDATE ON entity_refs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stateplane_check_entity_payload();

-- Space erasure removes evidence before the records and identities it cites.
-- Original bytes in the blob store are outside this transaction.
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
  UPDATE public.spaces SET lifecycle='deleted',policy_version=policy_version+1 WHERE space_id=p_space_id;
END;
$$;
