-- STA-57 (STA-15 slice 1): storage for bounded analytical work. Analysis and
-- export jobs pinned to a consistent boundary, their bounded result pages and
-- manifests, per-space and per-cell analytical concurrency slots, and an as-of
-- reconstruction index over record events by feed position
-- (docs/analysis-jobs.md). No aggregation, job worker or transport.
--
-- Take this step's locks up front, the event feed first: a space purge deletes
-- record events, and so feed rows, before it deletes collections and updates
-- its space, so taking the feed first never waits while holding a lock that
-- purge needs. The migrator bounds the waits and the feed backfill
-- (scripts/migrate.mjs).
LOCK TABLE record_event_feed IN ACCESS EXCLUSIVE MODE;
LOCK TABLE collections, collection_versions, spaces IN SHARE ROW EXCLUSIVE MODE;

-- As-of reconstruction. A record's state at a watermark (a feed position) is
-- its highest revision whose event is published at or below the watermark.
-- Each feed row now carries its event's record and revision, so that lookup
-- walks one index, without reading events, from the record's latest revision
-- down past only the revisions published after the watermark. Taking the
-- highest revision, not the highest position, keeps the answer right even if
-- two revisions of one record were ever published out of order.
ALTER TABLE record_event_feed ADD COLUMN record_id text, ADD COLUMN revision bigint;
UPDATE record_event_feed f SET record_id = e.record_id, revision = e.revision
  FROM record_events e
  WHERE e.event_id = f.event_id AND e.space_id = f.space_id AND e.collection_id = f.collection_id;
ALTER TABLE record_event_feed ALTER COLUMN record_id SET NOT NULL, ALTER COLUMN revision SET NOT NULL;

-- Derived from the event on every write, whatever the writer sends, so a
-- publisher that predates this step and one that names another collection's
-- event are handled alike.
CREATE FUNCTION stateplane_feed_event_record() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  SELECT e.record_id, e.revision INTO NEW.record_id, NEW.revision FROM public.record_events e
    WHERE e.event_id = NEW.event_id AND e.space_id = NEW.space_id AND e.collection_id = NEW.collection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a feed position names an event of its own collection'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'record_event_feed_event';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_feed_event_record() FROM PUBLIC;
CREATE TRIGGER record_event_feed_record BEFORE INSERT OR UPDATE ON record_event_feed
  FOR EACH ROW EXECUTE FUNCTION stateplane_feed_event_record();
CREATE INDEX record_event_feed_as_of ON record_event_feed(space_id, collection_id, record_id, revision) INCLUDE (position);

-- One analysis or export job over one collection. Its binding never changes:
-- the requesting principal, credential and capability with the space policy
-- version and placement generation it was admitted under, the collection's
-- schema version, the watermark (a position of the collection's event feed, or
-- 0 before its first event), the canonical spec and its SHA-256 digest, and
-- its budgets and expiry. Its state moves forward only.
CREATE TABLE analysis_jobs (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  job_id text NOT NULL CHECK (job_id ~ '^anj_[0-9a-f-]{36}$'),
  kind text NOT NULL CHECK (kind IN ('aggregate', 'export')),
  principal_id text NOT NULL CHECK (char_length(principal_id) > 0),
  credential_id text NOT NULL CHECK (char_length(credential_id) > 0),
  capability text NOT NULL CHECK (capability IN ('records:read', 'export:read')),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  placement_generation bigint NOT NULL CHECK (placement_generation > 0),
  schema_version bigint NOT NULL,
  watermark bigint NOT NULL CHECK (watermark >= 0),
  canonical_spec text NOT NULL,
  spec_digest text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'expired')),
  -- Checkpoint: the last record the job finished, in key order, and its partial state.
  cursor_record_id text CHECK (char_length(cursor_record_id) > 0),
  checkpoint jsonb,
  records_scanned bigint NOT NULL DEFAULT 0 CHECK (records_scanned >= 0),
  runtime_ms bigint NOT NULL DEFAULT 0 CHECK (runtime_ms >= 0),
  budget_records bigint NOT NULL CHECK (budget_records > 0),
  budget_bytes bigint NOT NULL CHECK (budget_bytes > 0),
  budget_runtime_ms bigint NOT NULL CHECK (budget_runtime_ms > 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id text CHECK (char_length(lease_id) BETWEEN 1 AND 128),
  leased_until timestamptz,
  failure_code text CHECK (failure_code ~ '^[A-Z][A-Z_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  started_at timestamptz,
  cancel_requested_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (space_id, collection_id, job_id),
  -- Result pages and manifests carry and reference this binding.
  CONSTRAINT analysis_jobs_result_binding UNIQUE (space_id, collection_id, job_id, credential_id, spec_digest, schema_version, watermark),
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id),
  FOREIGN KEY (space_id, collection_id, schema_version) REFERENCES collection_versions(space_id, collection_id, version),
  -- Initial protective bounds, not measured (docs/analysis-jobs.md#limits).
  CONSTRAINT analysis_jobs_spec CHECK (octet_length(canonical_spec) <= 65536 AND jsonb_typeof(canonical_spec::jsonb) = 'object'),
  CONSTRAINT analysis_jobs_checkpoint CHECK (jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 1048576),
  CONSTRAINT analysis_jobs_spec_digest CHECK (spec_digest = encode(sha256(convert_to(canonical_spec, 'UTF8')), 'hex')),
  CONSTRAINT analysis_jobs_budget CHECK (records_scanned <= budget_records AND runtime_ms <= budget_runtime_ms),
  CONSTRAINT analysis_jobs_expiry CHECK (expires_at > created_at AND leased_until <= expires_at),
  CONSTRAINT analysis_jobs_lease CHECK ((lease_id IS NULL) = (leased_until IS NULL)
    AND (state <> 'running' OR lease_id IS NOT NULL) AND (state IN ('running', 'cancelling') OR lease_id IS NULL)),
  CONSTRAINT analysis_jobs_failure CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT analysis_jobs_stamps CHECK ((state IN ('cancelled', 'completed', 'failed', 'expired')) = (finished_at IS NOT NULL)
    AND (state NOT IN ('running', 'completed') OR started_at IS NOT NULL)
    AND (state NOT IN ('cancelling', 'cancelled') OR cancel_requested_at IS NOT NULL))
);
-- Jobs still to run, cancel or expire, and completed jobs whose results expire.
CREATE INDEX analysis_jobs_expiry ON analysis_jobs(expires_at) WHERE state IN ('queued', 'running', 'cancelling', 'completed');

-- Analytical concurrency slots, kept apart from interactive capacity. A slot
-- is free, or held by one job of its space (cell) until `held_until`; a job
-- holds at most one slot of each kind. A statement that needs no job (an
-- interactive aggregation) holds a free slot's row lock for its transaction
-- instead. The slot numbers bound the capacity; the rows present set it
-- (docs/analysis-jobs.md#concurrency-slots).
CREATE TABLE analysis_space_slots (
  space_id text NOT NULL REFERENCES spaces(space_id),
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 10),
  holder_collection_id text,
  holder_job_id text,
  held_until timestamptz,
  PRIMARY KEY (space_id, slot),
  CONSTRAINT analysis_space_slots_one_per_job UNIQUE (space_id, holder_collection_id, holder_job_id),
  CONSTRAINT analysis_space_slots_holder FOREIGN KEY (space_id, holder_collection_id, holder_job_id)
    REFERENCES analysis_jobs(space_id, collection_id, job_id),
  CHECK ((holder_job_id IS NULL) = (holder_collection_id IS NULL) AND (holder_job_id IS NULL) = (held_until IS NULL))
);
CREATE TABLE analysis_cell_slots (
  cell_id text NOT NULL CHECK (char_length(cell_id) > 0),
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 10),
  holder_space_id text,
  holder_collection_id text,
  holder_job_id text,
  held_until timestamptz,
  PRIMARY KEY (cell_id, slot),
  -- Also finds the slots a space's jobs hold, for the purge and the erasure check.
  CONSTRAINT analysis_cell_slots_one_per_job UNIQUE (holder_space_id, holder_collection_id, holder_job_id),
  CONSTRAINT analysis_cell_slots_holder FOREIGN KEY (holder_space_id, holder_collection_id, holder_job_id)
    REFERENCES analysis_jobs(space_id, collection_id, job_id),
  CHECK ((holder_job_id IS NULL) = (holder_space_id IS NULL) AND (holder_job_id IS NULL) = (holder_collection_id IS NULL)
    AND (holder_job_id IS NULL) = (held_until IS NULL))
);

-- A job is admitted queued, with nothing done, into a live space and
-- collection, under their current policy version, placement generation and
-- schema version, for its space's owner or a credential whose current grant
-- on the collection includes its capability, at a watermark that is a
-- position of that collection's feed (or 0 while it has none). The space and
-- collection rows are share-locked, as record writers lock them, so a
-- lifecycle, policy, placement or schema change waits for the admission and
-- an admission that meets one in flight waits and is then checked against it.
--
-- Afterwards only its state, checkpoint, progress, attempts, lease and
-- failure change. A running job progresses before it expires; it ends
-- completed (with a manifest), failed (with a code), cancelled (through
-- cancelling once it runs) or expired (once its expiry has passed, also after
-- completing, when its results expire). Ending a job clears its lease and
-- releases its slots. Each state stamps its own time.
CREATE FUNCTION stateplane_guard_analysis_job() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  space record;
  collection record;
  ended text[] := ARRAY['cancelled', 'completed', 'failed', 'expired'];
  mutable text[] := ARRAY['state', 'cursor_record_id', 'checkpoint', 'records_scanned', 'runtime_ms', 'attempts', 'lease_id',
    'leased_until', 'failure_code', 'started_at', 'cancel_requested_at', 'finished_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT s.lifecycle, s.policy_version, s.placement_generation, s.owner_principal_id INTO space
      FROM public.spaces s WHERE s.space_id = NEW.space_id FOR SHARE;
    SELECT c.lifecycle, c.schema_version INTO collection
      FROM public.collections c WHERE c.space_id = NEW.space_id AND c.collection_id = NEW.collection_id FOR SHARE;
    IF space.lifecycle IS NULL OR space.lifecycle NOT IN ('active', 'readOnly') OR collection.lifecycle IS NULL
      OR collection.lifecycle = 'deleted' THEN
      RAISE EXCEPTION 'an analysis job is admitted into a live space and collection'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_jobs_admission';
    END IF;
    IF NEW.policy_version <> space.policy_version OR NEW.placement_generation <> space.placement_generation
      OR NEW.schema_version <> collection.schema_version THEN
      RAISE EXCEPTION 'an analysis job binds the current policy version, placement generation and schema version'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_jobs_binding';
    END IF;
    IF NEW.principal_id <> space.owner_principal_id AND NOT EXISTS (SELECT 1 FROM public.collection_grants g
        WHERE g.space_id = NEW.space_id AND g.collection_id = NEW.collection_id AND g.credential_id = NEW.credential_id
          AND NEW.capability = ANY (g.capabilities) AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())) THEN
      RAISE EXCEPTION 'an analysis job binds its space owner or a current grant of its capability'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_jobs_grant';
    END IF;
    IF (NEW.watermark = 0 AND EXISTS (SELECT 1 FROM public.record_event_feed f
          WHERE f.space_id = NEW.space_id AND f.collection_id = NEW.collection_id))
      OR (NEW.watermark <> 0 AND NOT EXISTS (SELECT 1 FROM public.record_event_feed f
          WHERE f.position = NEW.watermark AND f.space_id = NEW.space_id AND f.collection_id = NEW.collection_id)) THEN
      RAISE EXCEPTION 'an analysis job watermark is a position of its collection''s event feed, or 0 before its first event'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_jobs_watermark';
    END IF;
    IF NEW.state <> 'queued' OR NEW.cursor_record_id IS NOT NULL OR NEW.checkpoint IS NOT NULL OR NEW.records_scanned <> 0
      OR NEW.runtime_ms <> 0 OR NEW.attempts <> 0 OR NEW.lease_id IS NOT NULL OR NEW.started_at IS NOT NULL
      OR NEW.cancel_requested_at IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'an analysis job starts queued with nothing done'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_jobs_transition';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'an analysis job''s binding, budgets and expiry never change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_jobs_binding';
  END IF;
  IF (OLD.state, NEW.state) NOT IN (('queued', 'running'), ('queued', 'cancelled'), ('queued', 'failed'), ('queued', 'expired'),
      ('running', 'running'), ('running', 'cancelling'), ('running', 'completed'), ('running', 'failed'), ('running', 'expired'),
      ('cancelling', 'cancelling'), ('cancelling', 'cancelled'), ('cancelling', 'expired'), ('completed', 'expired'))
    OR (OLD.state <> 'running' AND (NEW.cursor_record_id, NEW.checkpoint, NEW.records_scanned, NEW.runtime_ms)
      IS DISTINCT FROM (OLD.cursor_record_id, OLD.checkpoint, OLD.records_scanned, OLD.runtime_ms))
    OR NEW.records_scanned < OLD.records_scanned OR NEW.runtime_ms < OLD.runtime_ms
    OR NEW.attempts < OLD.attempts OR (NEW.attempts <> OLD.attempts AND NEW.state <> 'running') THEN
    RAISE EXCEPTION 'analysis job cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_jobs_transition';
  END IF;
  IF (NEW.state IN ('running', 'completed') AND clock_timestamp() >= OLD.expires_at)
    OR (NEW.state = 'expired' AND clock_timestamp() < OLD.expires_at) THEN
    RAISE EXCEPTION 'an analysis job runs and completes before it expires, and expires only after'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_jobs_expiry';
  END IF;
  IF NEW.state = 'completed' AND OLD.state <> 'completed' AND NOT EXISTS (SELECT 1 FROM public.analysis_result_manifests m
      WHERE m.space_id = NEW.space_id AND m.collection_id = NEW.collection_id AND m.job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'an analysis job completes with its result manifest'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_jobs_manifest';
  END IF;
  NEW.started_at := COALESCE(OLD.started_at, CASE WHEN NEW.state = 'running' THEN clock_timestamp() END);
  NEW.cancel_requested_at := CASE WHEN NEW.state IN ('cancelling', 'cancelled') AND OLD.state NOT IN ('cancelling', 'cancelled')
    THEN clock_timestamp() ELSE OLD.cancel_requested_at END;
  NEW.finished_at := CASE WHEN NEW.state = ANY (ended) AND OLD.state <> ALL (ended) THEN clock_timestamp() ELSE OLD.finished_at END;
  IF NEW.state = ANY (ended) THEN
    NEW.lease_id := NULL;
    NEW.leased_until := NULL;
    UPDATE public.analysis_space_slots s SET holder_collection_id = NULL, holder_job_id = NULL, held_until = NULL
      WHERE s.space_id = NEW.space_id AND s.holder_collection_id = NEW.collection_id AND s.holder_job_id = NEW.job_id;
    UPDATE public.analysis_cell_slots s SET holder_space_id = NULL, holder_collection_id = NULL, holder_job_id = NULL,
      held_until = NULL
      WHERE s.holder_space_id = NEW.space_id AND s.holder_collection_id = NEW.collection_id AND s.holder_job_id = NEW.job_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_analysis_job() FROM PUBLIC;
CREATE TRIGGER analysis_jobs_transition BEFORE INSERT OR UPDATE ON analysis_jobs
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_analysis_job();
-- A job's row stays until its space is erased.
CREATE TRIGGER analysis_jobs_kept BEFORE DELETE ON analysis_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER analysis_jobs_no_truncate BEFORE TRUNCATE ON analysis_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();

-- One bounded page of a job's result, in order: its rows and bytes follow the
-- previous page's, its content is at most 1 MiB, its SHA-256 digest is
-- checked, and the job's result bytes stay within its byte budget. Every page
-- carries, and by foreign key equals, its job's binding.
CREATE TABLE analysis_result_pages (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  job_id text NOT NULL,
  credential_id text NOT NULL,
  spec_digest text NOT NULL,
  schema_version bigint NOT NULL,
  watermark bigint NOT NULL,
  page_number integer NOT NULL CHECK (page_number > 0),
  row_offset bigint NOT NULL CHECK (row_offset >= 0),
  row_count integer NOT NULL CHECK (row_count >= 0),
  byte_offset bigint NOT NULL CHECK (byte_offset >= 0),
  byte_size integer GENERATED ALWAYS AS (octet_length(content)) STORED,
  content text NOT NULL CHECK (octet_length(content) <= 1048576),
  content_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, job_id, page_number),
  CONSTRAINT analysis_result_pages_binding FOREIGN KEY (space_id, collection_id, job_id, credential_id, spec_digest, schema_version, watermark)
    REFERENCES analysis_jobs(space_id, collection_id, job_id, credential_id, spec_digest, schema_version, watermark),
  CONSTRAINT analysis_result_pages_digest CHECK (content_sha256 = encode(sha256(convert_to(content, 'UTF8')), 'hex'))
);

-- A job's complete result: its page count and total rows and bytes, and the
-- SHA-256 digest of its pages' digests (lowercase hex) concatenated in page
-- order, all checked against its pages. Only a manifest marks a result
-- complete; a job completes with one and writes no page after it.
CREATE TABLE analysis_result_manifests (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  job_id text NOT NULL,
  credential_id text NOT NULL,
  spec_digest text NOT NULL,
  schema_version bigint NOT NULL,
  watermark bigint NOT NULL,
  page_count integer NOT NULL CHECK (page_count >= 0),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, job_id),
  CONSTRAINT analysis_result_manifests_binding FOREIGN KEY (space_id, collection_id, job_id, credential_id, spec_digest, schema_version, watermark)
    REFERENCES analysis_jobs(space_id, collection_id, job_id, credential_id, spec_digest, schema_version, watermark)
);

-- Pages and manifests are written by their running job under an unexpired
-- lease before the job expires, under a share lock of the job row, so cancelling, failing or expiring the
-- job waits for a write in flight and a write that meets one in flight is then
-- refused. They never change. They are removed once their job is cancelled,
-- failed or expired, or with their space.
CREATE FUNCTION stateplane_guard_analysis_result() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  job record;
  previous record;
  totals record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF (current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID))
        AND current_setting('stateplane.erasing_space', true) = OLD.space_id)
      OR EXISTS (SELECT 1 FROM public.analysis_jobs j WHERE j.space_id = OLD.space_id AND j.collection_id = OLD.collection_id
        AND j.job_id = OLD.job_id AND j.state IN ('cancelled', 'failed', 'expired')) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% rows are kept while their job runs or its completed result lives', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_kept';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_immutable';
  END IF;
  SELECT j.state, j.expires_at, j.leased_until, j.budget_bytes INTO job FROM public.analysis_jobs j
    WHERE j.space_id = NEW.space_id AND j.collection_id = NEW.collection_id AND j.job_id = NEW.job_id FOR SHARE;
  IF job.state IS DISTINCT FROM 'running' OR clock_timestamp() >= job.expires_at OR clock_timestamp() >= job.leased_until THEN
    RAISE EXCEPTION '% rows are written by their running job under an unexpired lease before it expires', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_job';
  END IF;
  IF EXISTS (SELECT 1 FROM public.analysis_result_manifests m
      WHERE m.space_id = NEW.space_id AND m.collection_id = NEW.collection_id AND m.job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'an analysis result is sealed by its manifest'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_sealed';
  END IF;
  NEW.created_at := clock_timestamp();
  IF TG_TABLE_NAME = 'analysis_result_pages' THEN
    IF NEW.page_number = 1 THEN
      SELECT 0::bigint AS rows_after, 0::bigint AS bytes_after INTO previous;
    ELSE
      SELECT p.row_offset + p.row_count AS rows_after, p.byte_offset + p.byte_size AS bytes_after INTO previous
        FROM public.analysis_result_pages p WHERE p.space_id = NEW.space_id AND p.collection_id = NEW.collection_id
          AND p.job_id = NEW.job_id AND p.page_number = NEW.page_number - 1;
    END IF;
    IF previous.rows_after IS DISTINCT FROM NEW.row_offset OR previous.bytes_after IS DISTINCT FROM NEW.byte_offset THEN
      RAISE EXCEPTION 'an analysis result page follows the previous page''s rows and bytes'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_result_pages_order';
    END IF;
    IF NEW.byte_offset + octet_length(NEW.content) > job.budget_bytes THEN
      RAISE EXCEPTION 'an analysis result stays within its job''s byte budget'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_result_pages_budget';
    END IF;
    RETURN NEW;
  END IF;
  SELECT count(*)::integer AS pages, COALESCE(sum(p.row_count), 0)::bigint AS rows, COALESCE(sum(p.byte_size), 0)::bigint AS bytes,
      encode(sha256(convert_to(COALESCE(string_agg(p.content_sha256, '' ORDER BY p.page_number), ''), 'UTF8')), 'hex') AS digest
    INTO totals FROM public.analysis_result_pages p
    WHERE p.space_id = NEW.space_id AND p.collection_id = NEW.collection_id AND p.job_id = NEW.job_id;
  IF (NEW.page_count, NEW.row_count, NEW.byte_size, NEW.result_sha256) IS DISTINCT FROM
      (totals.pages, totals.rows, totals.bytes, totals.digest) THEN
    RAISE EXCEPTION 'an analysis result manifest states its pages'' count, rows, bytes and digest'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'analysis_result_manifests_totals';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_analysis_result() FROM PUBLIC;
CREATE TRIGGER analysis_result_pages_guard BEFORE INSERT OR UPDATE OR DELETE ON analysis_result_pages
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_analysis_result();
CREATE TRIGGER analysis_result_pages_no_truncate BEFORE TRUNCATE ON analysis_result_pages
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER analysis_result_manifests_guard BEFORE INSERT OR UPDATE OR DELETE ON analysis_result_manifests
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_analysis_result();
CREATE TRIGGER analysis_result_manifests_no_truncate BEFORE TRUNCATE ON analysis_result_manifests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();

-- A slot keeps its number. A held slot passes to another job only once its
-- hold has lapsed. It is taken by a job that has not ended, of a space on the
-- slot's cell, holding it no later than the job expires; the job row is
-- share-locked, so a job that ends meanwhile waits for the taking and then
-- releases the slot, and a taking that meets an ending in flight is refused.
-- Lock a job before its slots.
CREATE FUNCTION stateplane_guard_analysis_slot() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  holder jsonb := to_jsonb(NEW);
  job record;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) ->> 'slot', to_jsonb(OLD) ->> 'space_id', to_jsonb(OLD) ->> 'cell_id')
      IS DISTINCT FROM (holder ->> 'slot', holder ->> 'space_id', holder ->> 'cell_id') THEN
    RAISE EXCEPTION 'an analysis slot keeps its number'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_key';
  END IF;
  IF NEW.holder_job_id IS NULL OR (TG_OP = 'UPDATE' AND to_jsonb(OLD) = holder) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.holder_job_id IS NOT NULL AND OLD.held_until > clock_timestamp()
    AND (to_jsonb(OLD) ->> 'holder_space_id', OLD.holder_collection_id, OLD.holder_job_id)
      IS DISTINCT FROM (holder ->> 'holder_space_id', NEW.holder_collection_id, NEW.holder_job_id) THEN
    RAISE EXCEPTION 'an analysis slot passes to another job only once its hold has lapsed'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_held';
  END IF;
  SELECT j.state, j.expires_at, s.cell_id INTO job FROM public.analysis_jobs j JOIN public.spaces s ON s.space_id = j.space_id
    WHERE j.space_id = COALESCE(holder ->> 'holder_space_id', holder ->> 'space_id')
      AND j.collection_id = NEW.holder_collection_id AND j.job_id = NEW.holder_job_id
    FOR SHARE OF j;
  IF job.state IS NULL OR job.state NOT IN ('queued', 'running', 'cancelling') OR NEW.held_until > job.expires_at
    OR (TG_TABLE_NAME = 'analysis_cell_slots' AND job.cell_id IS DISTINCT FROM holder ->> 'cell_id') THEN
    RAISE EXCEPTION 'an analysis slot is held by a job of its space or cell that has not ended, until it expires at the latest'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_holder';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_analysis_slot() FROM PUBLIC;
CREATE TRIGGER analysis_space_slots_guard BEFORE INSERT OR UPDATE ON analysis_space_slots
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_analysis_slot();
CREATE TRIGGER analysis_cell_slots_guard BEFORE INSERT OR UPDATE ON analysis_cell_slots
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_analysis_slot();

-- Space erasure removes analysis work before the collections it references,
-- as migration 045's routine removes retrieval rows. It locks the space's jobs
-- first, so a page, manifest or slot write in flight finishes first and none
-- starts after, releases the cell slots they hold, and then removes their
-- space slots, pages, manifests and jobs.
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
  PERFORM 1 FROM public.analysis_jobs WHERE space_id=p_space_id FOR UPDATE;
  UPDATE public.analysis_cell_slots SET holder_space_id=NULL, holder_collection_id=NULL, holder_job_id=NULL, held_until=NULL
    WHERE holder_space_id=p_space_id;
  DELETE FROM public.analysis_space_slots WHERE space_id=p_space_id;
  DELETE FROM public.analysis_result_pages WHERE space_id=p_space_id;
  DELETE FROM public.analysis_result_manifests WHERE space_id=p_space_id;
  DELETE FROM public.analysis_jobs WHERE space_id=p_space_id;
  DELETE FROM public.batch_operations WHERE space_id=p_space_id;
  DELETE FROM public.projection_reconciliations WHERE space_id=p_space_id;
  DELETE FROM public.projection_heads WHERE space_id=p_space_id;
  DELETE FROM public.outbox_space_rotation WHERE space_id=p_space_id;
  DELETE FROM public.projection_outbox WHERE space_id=p_space_id;
  DELETE FROM public.embedding_checkpoints WHERE space_id=p_space_id;
  DELETE FROM public.vector_chunks WHERE space_id=p_space_id;
  DELETE FROM public.lexical_chunks WHERE space_id=p_space_id;
  DELETE FROM public.projection_deletion_receipts WHERE space_id=p_space_id;
  DELETE FROM public.projection_refs WHERE space_id=p_space_id;
  DELETE FROM public.projection_generations WHERE space_id=p_space_id;
  DELETE FROM public.retrieval_collection_heads WHERE space_id=p_space_id;
  DELETE FROM public.retrieval_policies WHERE space_id=p_space_id;
  DELETE FROM public.retrieval_outbox WHERE space_id=p_space_id;
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
