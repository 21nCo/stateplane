-- STA-48 (STA-14 slice 5): rebuilds, verified activation, rollback and
-- retirement of projection generations
-- (docs/retrieval-projections.md#generations-rebuild-and-model-migration-sta-48).
--
-- A generation that an activation replaces becomes `standby`: still projected
-- by the worker like every generation that is not retired, never searched,
-- and the only one a rollback can make active again. At most one generation
-- of a collection is on standby; activating another retires it. A retired
-- generation's chunks and checkpoints are derived data and are removed after
-- it retires; `pruned_at` records that they are all gone. Its projected Refs
-- and deletion receipts stay until erasure.
ALTER TABLE projection_generations ADD COLUMN standby_at timestamptz;
ALTER TABLE projection_generations ADD COLUMN pruned_at timestamptz;
ALTER TABLE projection_generations DROP CONSTRAINT projection_generations_state_check;
ALTER TABLE projection_generations ADD CONSTRAINT projection_generations_state_check
  CHECK (state IN ('building', 'verifying', 'active', 'standby', 'retired'));
ALTER TABLE projection_generations ADD CONSTRAINT projection_generations_standby_stamps
  CHECK (state <> 'standby' OR (verifying_at IS NOT NULL AND activated_at IS NOT NULL AND standby_at IS NOT NULL));
ALTER TABLE projection_generations ADD CONSTRAINT projection_generations_pruned
  CHECK (pruned_at IS NULL OR state = 'retired');
CREATE UNIQUE INDEX projection_generations_standby ON projection_generations(space_id, collection_id)
  WHERE state = 'standby';
-- Retired generations whose chunks are still being removed.
CREATE INDEX projection_generations_unpruned ON projection_generations(space_id, collection_id, generation)
  WHERE state = 'retired' AND pruned_at IS NULL;

-- 045's guard, with the standby transitions: an active generation steps down
-- to standby when another activates, comes back on rollback, and retires.
-- `pruned_at` is set once, on a retired generation, and nothing else changes
-- with it.
CREATE OR REPLACE FUNCTION stateplane_guard_projection_generation() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  head record;
  stamps text[] := ARRAY['state', 'verifying_at', 'activated_at', 'standby_at', 'retired_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT h.policy_version, h.generation INTO head FROM public.retrieval_collection_heads h
      WHERE h.space_id = NEW.space_id AND h.collection_id = NEW.collection_id FOR UPDATE;
    IF NEW.state <> 'building' OR NEW.verifying_at IS NOT NULL OR NEW.activated_at IS NOT NULL
      OR NEW.standby_at IS NOT NULL OR NEW.retired_at IS NOT NULL OR NEW.pruned_at IS NOT NULL THEN
      RAISE EXCEPTION 'a projection generation starts building'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_transition';
    END IF;
    IF head.policy_version IS DISTINCT FROM NEW.policy_version THEN
      RAISE EXCEPTION 'a projection generation is built under its collection''s current retrieval policy'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_policy';
    END IF;
    IF (SELECT p.vector FROM public.retrieval_policies p WHERE p.space_id = NEW.space_id
        AND p.collection_id = NEW.collection_id AND p.version = NEW.policy_version) <> (NEW.embedder IS NOT NULL) THEN
      RAISE EXCEPTION 'a projection generation names an embedder exactly when its policy enables vectors'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_policy';
    END IF;
    IF head.generation >= NEW.generation THEN
      RAISE EXCEPTION 'projection generations increase'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_order';
    END IF;
    UPDATE public.retrieval_collection_heads h SET generation = NEW.generation
      WHERE h.space_id = NEW.space_id AND h.collection_id = NEW.collection_id;
    RETURN NEW;
  END IF;
  IF OLD.state = 'retired' AND NEW.state = 'retired' AND OLD.pruned_at IS NULL AND NEW.pruned_at IS NOT NULL
    AND (to_jsonb(NEW) - 'pruned_at') = (to_jsonb(OLD) - 'pruned_at') THEN
    NEW.pruned_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - stamps) IS DISTINCT FROM (to_jsonb(OLD) - stamps)
    OR (OLD.state, NEW.state) NOT IN (('building', 'verifying'), ('building', 'retired'), ('verifying', 'active'),
      ('verifying', 'retired'), ('active', 'standby'), ('active', 'retired'), ('standby', 'active'),
      ('standby', 'retired')) THEN
    RAISE EXCEPTION 'projection generation cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_transition';
  END IF;
  NEW.verifying_at := CASE WHEN NEW.state = 'verifying' THEN clock_timestamp() ELSE OLD.verifying_at END;
  NEW.activated_at := CASE WHEN NEW.state = 'active' THEN clock_timestamp() ELSE OLD.activated_at END;
  NEW.standby_at := CASE WHEN NEW.state = 'standby' THEN clock_timestamp() ELSE OLD.standby_at END;
  NEW.retired_at := CASE WHEN NEW.state = 'retired' THEN clock_timestamp() ELSE OLD.retired_at END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_projection_generation() FROM PUBLIC;

-- A rebuild of one generation from authority: a resumable job that walks the
-- collection's Refs in key order (kind, then ID), projecting each into the
-- generation (`backfill`), then walks them again checking each against
-- authority (`verify`), ending `verified` or `failed`. The cursor is the last
-- Ref the phase finished, so an interrupted job resumes after it. A job is
-- leased by moving `available_at` past the lease, as retrieval work is; only
-- that exact lease may move it. Delivery state only: removed with its
-- generation when the space is erased.
CREATE TABLE projection_rebuilds (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  generation bigint NOT NULL,
  phase text NOT NULL DEFAULT 'backfill' CHECK (phase IN ('backfill', 'verify', 'verified', 'failed')),
  cursor_kind text CHECK (cursor_kind IN ('claim', 'record', 'source')),
  cursor_id text CHECK (char_length(cursor_id) > 0),
  backfilled bigint NOT NULL DEFAULT 0 CHECK (backfilled >= 0),
  verified bigint NOT NULL DEFAULT 0 CHECK (verified >= 0),
  repaired bigint NOT NULL DEFAULT 0 CHECK (repaired >= 0),
  mismatched bigint NOT NULL DEFAULT 0 CHECK (mismatched >= 0),
  -- At most 20 Refs that failed verification, each {kind, id, reason}.
  mismatches jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(mismatches) = 'array' AND jsonb_array_length(mismatches) <= 20),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text CHECK (char_length(last_error) > 0 AND octet_length(last_error) <= 1024),
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  backfilled_at timestamptz,
  verified_at timestamptz,
  PRIMARY KEY (space_id, collection_id, generation),
  FOREIGN KEY (space_id, collection_id, generation)
    REFERENCES projection_generations(space_id, collection_id, generation) ON DELETE CASCADE,
  CHECK ((cursor_kind IS NULL) = (cursor_id IS NULL)),
  CHECK ((last_error IS NULL) = (last_error_at IS NULL)),
  CHECK ((phase = 'backfill') = (backfilled_at IS NULL)),
  CHECK ((phase IN ('verified', 'failed')) = (verified_at IS NOT NULL))
);
CREATE INDEX projection_rebuilds_due ON projection_rebuilds(available_at) WHERE phase IN ('backfill', 'verify');
