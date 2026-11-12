-- STA-69 (STA-17 slice 1): storage for portable, recoverable spaces
-- (docs/portability-storage.md). No export, import, replay or transport code.
--
-- Control database: lifecycle stamps on the space directory (archived,
-- tombstoned, hard-erased) and the durable erasure ledger. Both live beside
-- the directory, outside the regional cell databases, so restoring a cell
-- from a backup cannot remove an entry or a stamp.
--
-- Cell databases: export and import jobs pinned to a consistency watermark,
-- their part ledgers, and the principal map an import uses to map a source
-- deployment's owner and grant holders to this deployment's principals and
-- reissued credentials. Space erasure removes them with the rest.
--
-- Every database receives every migration; in a single-database installation
-- control and cell tables share it (docs/owned-spaces.md).

-- Lifecycle stamps. `archived_at` is when the space last entered `readOnly`
-- (archive); it is kept through suspension and deletion and cleared when the
-- space returns to `active`. `tombstoned_at` is when the directory published
-- `deleted`. `hard_erased_at` is when the space was recorded hard-erased,
-- which needs its tombstone and a space entry in the erasure ledger; it is
-- final and keeps the space deleted. Spaces already archived or deleted take
-- their directory `updated_at`, the time of their last publication and so no
-- earlier than the state was entered.
ALTER TABLE space_directory ADD COLUMN archived_at timestamptz, ADD COLUMN tombstoned_at timestamptz,
  ADD COLUMN hard_erased_at timestamptz;
UPDATE space_directory SET archived_at = CASE WHEN lifecycle = 'readOnly' THEN updated_at END,
  tombstoned_at = CASE WHEN lifecycle = 'deleted' THEN updated_at END
  WHERE lifecycle IN ('readOnly', 'deleted');
ALTER TABLE space_directory
  ADD CONSTRAINT space_directory_archived CHECK ((lifecycle <> 'readOnly' OR archived_at IS NOT NULL)
    AND (archived_at IS NULL OR lifecycle IN ('readOnly', 'suspended', 'deleting', 'deleted'))),
  ADD CONSTRAINT space_directory_tombstoned CHECK ((lifecycle = 'deleted') = (tombstoned_at IS NOT NULL)),
  ADD CONSTRAINT space_directory_hard_erased CHECK (hard_erased_at IS NULL OR (tombstoned_at IS NOT NULL AND hard_erased_at >= tombstoned_at));

-- One erased object, recorded in the control database before or as its cell
-- erases it, and never changed or removed. `space`: a whole space, recorded
-- once its directory row is `deleting` or `deleted`. `source`: one source's
-- original bytes and extracted content, in a published space. `cell_id` is
-- the space's cell when recorded: the cell whose restore must replay it.
-- `erasure_id` orders entries by insertion, not commit; replay reads every
-- entry of a cell rather than continuing past an ID.
CREATE TABLE erasure_ledger (
  erasure_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('space', 'source')),
  space_id text NOT NULL REFERENCES space_directory(space_id),
  cell_id text NOT NULL CHECK (char_length(cell_id) > 0),
  collection_id text CHECK (char_length(collection_id) > 0),
  source_id text CHECK (char_length(source_id) > 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT erasure_ledger_target CHECK ((scope = 'space') = (collection_id IS NULL) AND (collection_id IS NULL) = (source_id IS NULL)),
  CONSTRAINT erasure_ledger_once UNIQUE NULLS NOT DISTINCT (scope, space_id, collection_id, source_id)
);
CREATE INDEX erasure_ledger_cell ON erasure_ledger(cell_id, erasure_id);

-- An entry names its space's current cell and a directory state that allows
-- it. The directory row is share locked, so a placement or lifecycle change
-- waits for the entry and an entry that meets one in flight is checked
-- against it.
CREATE FUNCTION stateplane_guard_erasure_ledger() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  directory record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'erasure ledger entries are never changed or removed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'erasure_ledger_immutable';
  END IF;
  SELECT d.cell_id, d.lifecycle INTO directory FROM public.space_directory d WHERE d.space_id = NEW.space_id FOR SHARE;
  IF directory.cell_id IS DISTINCT FROM NEW.cell_id THEN
    RAISE EXCEPTION 'an erasure ledger entry names its space''s current cell'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'erasure_ledger_cell';
  END IF;
  IF (NEW.scope = 'space' AND directory.lifecycle NOT IN ('deleting', 'deleted'))
    OR (NEW.scope = 'source' AND directory.lifecycle = 'provisioning') THEN
    RAISE EXCEPTION 'an erasure ledger % entry needs its space %', NEW.scope,
      CASE NEW.scope WHEN 'space' THEN 'deleting or deleted' ELSE 'published' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'erasure_ledger_lifecycle';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_erasure_ledger() FROM PUBLIC;
CREATE TRIGGER erasure_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON erasure_ledger
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_erasure_ledger();
CREATE TRIGGER erasure_ledger_no_truncate BEFORE TRUNCATE ON erasure_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION stateplane_guard_erasure_ledger();

-- Stamps follow the lifecycle a write publishes, whatever the writer sends:
-- existing directory writers need no change. `hard_erased_at` is set once, to
-- the database clock, on a tombstoned space with a space entry in the erasure
-- ledger, and the space then stays deleted.
CREATE FUNCTION stateplane_stamp_space_lifecycle() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.hard_erased_at IS NOT NULL AND NEW.lifecycle <> 'deleted' THEN
    RAISE EXCEPTION 'a hard-erased space stays deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'space_directory_hard_erased';
  END IF;
  IF NEW.lifecycle = 'readOnly' AND (TG_OP = 'INSERT' OR OLD.lifecycle <> 'readOnly') THEN
    NEW.archived_at := clock_timestamp();
  ELSIF TG_OP = 'INSERT' OR NEW.lifecycle IN ('active', 'provisioning') THEN
    NEW.archived_at := NULL;
  ELSE
    NEW.archived_at := OLD.archived_at;
  END IF;
  IF NEW.lifecycle = 'deleted' AND (TG_OP = 'INSERT' OR OLD.lifecycle <> 'deleted') THEN
    NEW.tombstoned_at := clock_timestamp();
  ELSIF TG_OP = 'INSERT' OR NEW.lifecycle <> 'deleted' THEN
    NEW.tombstoned_at := NULL;
  ELSE
    NEW.tombstoned_at := OLD.tombstoned_at;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.hard_erased_at IS NOT NULL THEN
    IF NEW.hard_erased_at IS DISTINCT FROM OLD.hard_erased_at THEN
      RAISE EXCEPTION 'a space''s hard erasure is final'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'space_directory_hard_erased';
    END IF;
  ELSIF NEW.hard_erased_at IS NOT NULL THEN
    IF TG_OP = 'INSERT' OR NEW.lifecycle <> 'deleted' OR NOT EXISTS (SELECT 1 FROM public.erasure_ledger l
        WHERE l.scope = 'space' AND l.space_id = NEW.space_id) THEN
      RAISE EXCEPTION 'a space is hard-erased once tombstoned, with a space entry in the erasure ledger'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'space_directory_hard_erased';
    END IF;
    NEW.hard_erased_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_stamp_space_lifecycle() FROM PUBLIC;
CREATE TRIGGER space_directory_lifecycle_stamps
  BEFORE INSERT OR UPDATE OF lifecycle, archived_at, tombstoned_at, hard_erased_at ON space_directory
  FOR EACH ROW EXECUTE FUNCTION stateplane_stamp_space_lifecycle();

-- One export or import of a whole space. Its binding never changes: the
-- space owner's principal and credential, the policy version and placement
-- generation it was admitted under, the manifest format version and the
-- consistency watermark. An export's watermark is a position of this cell's
-- record event feed published for the space (0 before its first), the
-- boundary every record it exports is read as of; an import's is the source
-- export's, as its manifest states. An export states its manifest digest and
-- part count when it completes; an import binds the digest and part count of
-- the manifest it applies from admission. Its state moves forward only.
CREATE TABLE portability_jobs (
  space_id text NOT NULL REFERENCES spaces(space_id),
  job_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('export', 'import')),
  principal_id text NOT NULL CHECK (char_length(principal_id) > 0),
  credential_id text NOT NULL CHECK (char_length(credential_id) > 0),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  placement_generation bigint NOT NULL CHECK (placement_generation > 0),
  format_version integer NOT NULL CHECK (format_version > 0),
  watermark bigint NOT NULL CHECK (watermark >= 0),
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  -- Initial protective bound, not measured (docs/portability-storage.md#limits).
  part_count integer CHECK (part_count BETWEEN 0 AND 100000),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'expired')),
  -- Checkpoint: where a resumed run continues.
  checkpoint jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id text CHECK (char_length(lease_id) BETWEEN 1 AND 128),
  leased_until timestamptz,
  failure_code text CHECK (failure_code ~ '^[A-Z][A-Z_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (space_id, job_id),
  -- Parts and principal map rows reference the job with its kind.
  CONSTRAINT portability_jobs_kind_key UNIQUE (space_id, job_id, kind),
  CONSTRAINT portability_jobs_id CHECK (job_id ~ ('^' || CASE kind WHEN 'export' THEN 'exp' ELSE 'imp' END
    || '_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  CONSTRAINT portability_jobs_manifest CHECK (CASE kind
    WHEN 'import' THEN manifest_sha256 IS NOT NULL AND part_count IS NOT NULL
    ELSE (manifest_sha256 IS NULL) = (part_count IS NULL) AND (state <> 'completed' OR manifest_sha256 IS NOT NULL)
      AND (manifest_sha256 IS NULL OR state IN ('completed', 'expired')) END),
  -- Initial protective bound, not measured (docs/portability-storage.md#limits).
  CONSTRAINT portability_jobs_checkpoint CHECK (jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 65536),
  CONSTRAINT portability_jobs_expiry CHECK (expires_at > created_at AND leased_until <= expires_at),
  CONSTRAINT portability_jobs_lease CHECK ((lease_id IS NULL) = (leased_until IS NULL) AND (state = 'running') = (lease_id IS NOT NULL)),
  CONSTRAINT portability_jobs_failure CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT portability_jobs_stamps CHECK ((state IN ('completed', 'failed', 'cancelled', 'expired')) = (finished_at IS NOT NULL)
    AND (state NOT IN ('running', 'completed') OR started_at IS NOT NULL))
);

-- A job is admitted queued, with nothing done, by its space's owner under the
-- current policy version and placement generation: an export into an active
-- or readOnly space at a watermark of the space's feed, an import into an
-- active space. The space row is share locked, as record writers lock it, so
-- a lifecycle, policy, placement or owner change waits for the admission and
-- an admission that meets one in flight is checked against it.
--
-- Afterwards only its state, checkpoint, attempts, lease, failure and stamps
-- change, and an export's manifest digest and part count as it completes. A
-- running job progresses before it expires; it ends completed (with all its
-- parts), failed (with a code), cancelled or expired (once its expiry has
-- passed, also after completing). Ending a job clears its lease.
CREATE FUNCTION stateplane_guard_portability_job() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  space record;
  ended text[] := ARRAY['completed', 'failed', 'cancelled', 'expired'];
  mutable text[] := ARRAY['state', 'checkpoint', 'attempts', 'lease_id', 'leased_until', 'failure_code', 'started_at', 'finished_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT s.lifecycle, s.policy_version, s.placement_generation, s.owner_principal_id INTO space
      FROM public.spaces s WHERE s.space_id = NEW.space_id FOR SHARE;
    IF space.lifecycle IS NULL OR space.lifecycle NOT IN ('active', 'readOnly')
      OR (NEW.kind = 'import' AND space.lifecycle <> 'active') THEN
      RAISE EXCEPTION 'a space % is admitted into %', NEW.kind,
        CASE NEW.kind WHEN 'export' THEN 'an active or readOnly space' ELSE 'an active space' END
        USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_jobs_admission';
    END IF;
    IF NEW.policy_version <> space.policy_version OR NEW.placement_generation <> space.placement_generation THEN
      RAISE EXCEPTION 'a portability job binds the current policy version and placement generation'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_jobs_binding';
    END IF;
    IF NEW.principal_id <> space.owner_principal_id THEN
      RAISE EXCEPTION 'a portability job binds its space''s owner'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_jobs_owner';
    END IF;
    IF NEW.kind = 'export' AND ((NEW.watermark = 0 AND EXISTS (SELECT 1 FROM public.record_event_feed f
          WHERE f.space_id = NEW.space_id))
      OR (NEW.watermark <> 0 AND NOT EXISTS (SELECT 1 FROM public.record_event_feed f
          WHERE f.position = NEW.watermark AND f.space_id = NEW.space_id))) THEN
      RAISE EXCEPTION 'an export watermark is a position of its space''s event feed, or 0 before its first event'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_jobs_watermark';
    END IF;
    IF NEW.state <> 'queued' OR NEW.checkpoint IS NOT NULL OR NEW.attempts <> 0 OR NEW.lease_id IS NOT NULL
      OR NEW.failure_code IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'a portability job starts queued with nothing done'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_jobs_transition';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  -- An update that changes nothing, as a part write's lock of its job row, passes as is.
  IF to_jsonb(NEW) = to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;
  IF NEW.kind = 'export' AND OLD.state = 'running' AND NEW.state = 'completed' THEN
    mutable := mutable || ARRAY['manifest_sha256', 'part_count'];
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'a portability job''s binding and expiry never change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_jobs_binding';
  END IF;
  IF (OLD.state, NEW.state) NOT IN (('queued', 'running'), ('queued', 'failed'), ('queued', 'cancelled'), ('queued', 'expired'),
      ('running', 'running'), ('running', 'completed'), ('running', 'failed'), ('running', 'cancelled'), ('running', 'expired'),
      ('completed', 'expired'))
    OR (OLD.state <> 'running' AND NEW.checkpoint IS DISTINCT FROM OLD.checkpoint)
    OR NEW.attempts < OLD.attempts OR (NEW.attempts <> OLD.attempts AND NEW.state <> 'running') THEN
    RAISE EXCEPTION 'portability job cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_jobs_transition';
  END IF;
  IF (NEW.state IN ('running', 'completed') AND clock_timestamp() >= OLD.expires_at)
    OR (NEW.state = 'expired' AND clock_timestamp() < OLD.expires_at) THEN
    RAISE EXCEPTION 'a portability job runs and completes before it expires, and expires only after'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_jobs_expiry';
  END IF;
  IF NEW.state = 'completed' AND OLD.state <> 'completed' AND NEW.part_count IS DISTINCT FROM (SELECT count(*)::integer
      FROM public.portability_parts p WHERE p.space_id = NEW.space_id AND p.job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'a portability job completes with all of its parts'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_jobs_parts';
  END IF;
  NEW.started_at := COALESCE(OLD.started_at, CASE WHEN NEW.state = 'running' THEN clock_timestamp() END);
  NEW.finished_at := CASE WHEN NEW.state = ANY (ended) AND OLD.state <> ALL (ended) THEN clock_timestamp() ELSE OLD.finished_at END;
  IF NEW.state = ANY (ended) THEN
    NEW.lease_id := NULL;
    NEW.leased_until := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_portability_job() FROM PUBLIC;
CREATE TRIGGER portability_jobs_transition BEFORE INSERT OR UPDATE ON portability_jobs
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_portability_job();
-- A job's row stays until its space is erased.
CREATE TRIGGER portability_jobs_kept BEFORE DELETE ON portability_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER portability_jobs_no_truncate BEFORE TRUNCATE ON portability_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();

-- One part of a job, numbered without gaps. An export part holds its content
-- (at most 1 MiB, its size and SHA-256 digest checked); an import part
-- records a part of the source export applied to this space, with the
-- section, rows, bytes and digest its manifest states, in the transaction
-- that applies it, and holds no content.
CREATE TABLE portability_parts (
  space_id text NOT NULL,
  job_id text NOT NULL,
  kind text NOT NULL,
  part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 100000),
  section text NOT NULL CHECK (section ~ '^[a-z][a-z0-9_]{0,62}$'),
  row_count integer NOT NULL CHECK (row_count >= 0),
  byte_size integer NOT NULL CHECK (byte_size >= 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- Initial protective bound, not measured (docs/portability-storage.md#limits).
  content text CHECK (octet_length(content) <= 1048576),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, job_id, part_number),
  FOREIGN KEY (space_id, job_id, kind) REFERENCES portability_jobs(space_id, job_id, kind),
  CONSTRAINT portability_parts_content CHECK (CASE kind
    WHEN 'export' THEN content IS NOT NULL AND byte_size = octet_length(content)
      AND content_sha256 = encode(sha256(convert_to(content, 'UTF8')), 'hex')
    ELSE content IS NULL END)
);

-- Parts are written by their running job under an unexpired lease before the
-- job expires, an import's no further than its manifest's part count. Each
-- write first updates its job row without changing it, so parts of one job
-- and its ending take turns: one that meets another in flight waits and is
-- then checked against it under READ COMMITTED, or fails with a
-- serialization error (40001) under REPEATABLE READ. So a completing job
-- counts exactly the parts committed before it, and none commits after it.
-- Parts never change.
CREATE FUNCTION stateplane_guard_portability_part() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  job record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'portability parts are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_parts_immutable';
  END IF;
  UPDATE public.portability_jobs j SET state = j.state WHERE j.space_id = NEW.space_id AND j.job_id = NEW.job_id
    RETURNING j.state, j.expires_at, j.leased_until, j.part_count INTO job;
  IF job.state IS DISTINCT FROM 'running' OR clock_timestamp() >= job.expires_at OR clock_timestamp() >= job.leased_until THEN
    RAISE EXCEPTION 'portability parts are written by their running job under an unexpired lease before it expires'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_parts_job';
  END IF;
  IF (NEW.part_number > 1 AND NOT EXISTS (SELECT 1 FROM public.portability_parts p
      WHERE p.space_id = NEW.space_id AND p.job_id = NEW.job_id AND p.part_number = NEW.part_number - 1))
    OR NEW.part_number > job.part_count THEN
    RAISE EXCEPTION 'portability parts are numbered without gaps, an import''s within its manifest''s part count'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_parts_order';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_portability_part() FROM PUBLIC;
CREATE TRIGGER portability_parts_guard BEFORE INSERT OR UPDATE ON portability_parts
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_portability_part();

-- An export's parts are removed once it is cancelled, failed or expired; an
-- import's record what was applied and stay. Both go with space erasure.
-- Invoker rights, as reject_retrieval_fact_change: only the table owner, as
-- the purge routine runs, is trusted with the erasing setting.
CREATE FUNCTION stateplane_keep_portability_part() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID))
      AND current_setting('stateplane.erasing_space', true) = OLD.space_id)
    OR (OLD.kind = 'export' AND EXISTS (SELECT 1 FROM public.portability_jobs j WHERE j.space_id = OLD.space_id
      AND j.job_id = OLD.job_id AND j.state IN ('cancelled', 'failed', 'expired'))) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'portability parts are kept while their export runs or its completed result lives, and an import''s always'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_parts_kept';
END;
$$;
REVOKE ALL ON FUNCTION stateplane_keep_portability_part() FROM PUBLIC;
CREATE TRIGGER portability_parts_kept BEFORE DELETE ON portability_parts
  FOR EACH ROW EXECUTE FUNCTION stateplane_keep_portability_part();
CREATE TRIGGER portability_parts_no_truncate BEFORE TRUNCATE ON portability_parts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();

-- An import's mapping of each principal of the source export to this
-- deployment. The source owner maps to the importing owner. Each source grant
-- holder maps to the principal of a credential reissued in this space, once
-- issued; a source credential or secret is never copied. One owner row per
-- import, and a reissued credential maps one source principal.
CREATE TABLE portability_principal_map (
  space_id text NOT NULL,
  job_id text NOT NULL,
  kind text NOT NULL DEFAULT 'import' CHECK (kind = 'import'),
  source_principal_id text NOT NULL CHECK (char_length(source_principal_id) BETWEEN 1 AND 256),
  role text NOT NULL CHECK (role IN ('owner', 'agent')),
  target_principal_id text CHECK (char_length(target_principal_id) > 0),
  target_credential_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  mapped_at timestamptz,
  PRIMARY KEY (space_id, job_id, source_principal_id),
  FOREIGN KEY (space_id, job_id, kind) REFERENCES portability_jobs(space_id, job_id, kind),
  FOREIGN KEY (space_id, target_credential_id) REFERENCES space_credentials(space_id, credential_id),
  CONSTRAINT portability_principal_map_credential UNIQUE (space_id, job_id, target_credential_id),
  CONSTRAINT portability_principal_map_target CHECK (CASE role
    WHEN 'owner' THEN target_principal_id IS NOT NULL AND target_credential_id IS NULL
    ELSE (target_principal_id IS NULL) = (target_credential_id IS NULL) END
    AND (target_principal_id IS NULL) = (mapped_at IS NULL))
);
CREATE UNIQUE INDEX portability_principal_map_owner ON portability_principal_map(space_id, job_id) WHERE role = 'owner';

-- Rows are written while their import is queued or running. The owner row
-- maps to the import's own principal; a grant holder's target is set once,
-- to a confirmed, unrevoked credential reissued in this space and that
-- credential's own principal. Nothing else changes. The job and credential rows are share
-- locked, so an ending import or a revocation waits for the write.
CREATE FUNCTION stateplane_guard_portability_principal() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  job record;
  credential record;
BEGIN
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'target_principal_id' - 'target_credential_id' - 'mapped_at')
      IS DISTINCT FROM (to_jsonb(OLD) - 'target_principal_id' - 'target_credential_id' - 'mapped_at')
      OR OLD.target_principal_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a principal mapping is set once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_principal_map_immutable';
  END IF;
  SELECT j.state, j.principal_id INTO job FROM public.portability_jobs j
    WHERE j.space_id = NEW.space_id AND j.job_id = NEW.job_id FOR SHARE;
  IF job.state IS NULL OR job.state NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'principal mappings are written while their import is queued or running'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_principal_map_job';
  END IF;
  IF NEW.role = 'owner' AND NEW.target_principal_id IS DISTINCT FROM job.principal_id THEN
    RAISE EXCEPTION 'a source owner maps to the importing owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_principal_map_target';
  END IF;
  IF NEW.target_credential_id IS NOT NULL THEN
    SELECT c.principal_id, c.confirmed_at, c.revoked_at FROM public.space_credentials c
      WHERE c.space_id = NEW.space_id AND c.credential_id = NEW.target_credential_id FOR SHARE INTO credential;
    IF credential.principal_id IS DISTINCT FROM NEW.target_principal_id OR credential.confirmed_at IS NULL
      OR credential.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a grant holder maps to a live reissued credential and its own principal'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'portability_principal_map_target';
    END IF;
  END IF;
  NEW.created_at := CASE TG_OP WHEN 'INSERT' THEN clock_timestamp() ELSE OLD.created_at END;
  NEW.mapped_at := CASE WHEN NEW.target_principal_id IS NOT NULL THEN clock_timestamp() END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_portability_principal() FROM PUBLIC;
CREATE TRIGGER portability_principal_map_guard BEFORE INSERT OR UPDATE ON portability_principal_map
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_portability_principal();
CREATE TRIGGER portability_principal_map_kept BEFORE DELETE ON portability_principal_map
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER portability_principal_map_no_truncate BEFORE TRUNCATE ON portability_principal_map
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();

REVOKE ALL ON erasure_ledger, portability_jobs, portability_parts, portability_principal_map FROM PUBLIC;

-- Space erasure removes portability work first, after its space and before
-- the credentials the principal map references. It locks the space's jobs
-- right after its space, so a part or mapping write in flight finishes first
-- and none starts after. Otherwise as migration 049's routine.
CREATE OR REPLACE FUNCTION stateplane_purge_space(p_space_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  writers_end timestamptz;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'a space purge runs under READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.spaces WHERE space_id=p_space_id AND lifecycle='deleting' FOR UPDATE) THEN
    RAISE EXCEPTION 'space is not deleting';
  END IF;
  -- An upload grant can still write the space's keys until it ends, after its rows are gone.
  SELECT COALESCE(max(expires_at), clock_timestamp()) INTO writers_end FROM public.source_upload_grants WHERE space_id=p_space_id;
  PERFORM set_config('stateplane.erasing_space', p_space_id, true);
  PERFORM 1 FROM public.portability_jobs WHERE space_id=p_space_id FOR UPDATE;
  DELETE FROM public.portability_principal_map WHERE space_id=p_space_id;
  DELETE FROM public.portability_parts WHERE space_id=p_space_id;
  DELETE FROM public.portability_jobs WHERE space_id=p_space_id;
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
