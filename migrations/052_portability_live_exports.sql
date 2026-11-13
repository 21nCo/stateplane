-- STA-70: the jobs Worker's export step reads only live export jobs (queued,
-- running, or completed and not yet expired) in its due probe, claim and
-- expiry pass, while ended jobs stay until their space is erased (migration
-- 051). Live exports are bounded per space (docs/portability-export.md#budgets),
-- so this partial index keeps those reads off the retained history. No export
-- writer runs before this slice, so the table is empty or small when this
-- builds. This file locks the job tables first, in a space purge's order
-- (portability jobs, then analysis jobs), and the strongest lock it needs, so
-- it never waits for one while holding the other; the migrator bounds that
-- wait and every statement (docs/portability-export.md#migration-052).
LOCK TABLE portability_jobs, analysis_jobs IN SHARE ROW EXCLUSIVE MODE;
CREATE INDEX IF NOT EXISTS portability_jobs_live ON portability_jobs(leased_until)
  WHERE kind = 'export' AND state IN ('queued', 'running', 'completed');

-- Submission counts its space's live exports, read by space through this
-- index, never through the space's retained ended history.
CREATE INDEX IF NOT EXISTS portability_jobs_live_space ON portability_jobs(space_id)
  WHERE kind = 'export' AND state IN ('queued', 'running', 'completed');

-- An ended job's result (an export's parts, an analysis job's pages) is
-- removed in committed batches, highest first, after the transaction that
-- ends the job. A job still holding rows waits for that in a removal queue,
-- one row per job with its rows left as its order, so the step finds the next
-- job to clear by reading the queue alone (jobs waiting for removal, never the
-- retained completed results or ended history), and submission counts its
-- space's exports there as held. A trigger queues the job in the same
-- transaction that ends it, whichever path ends it; the last batch removes it
-- from the queue, and a space purge removes it with its job. No ended job
-- holds rows before this slice (they went with the transaction that ended
-- them), so nothing is backfilled.
CREATE TABLE IF NOT EXISTS portability_removals (
  space_id text NOT NULL,
  job_id text NOT NULL,
  rows_left integer NOT NULL CHECK (rows_left > 0),
  PRIMARY KEY (space_id, job_id),
  FOREIGN KEY (space_id, job_id) REFERENCES portability_jobs(space_id, job_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS portability_removals_order ON portability_removals(rows_left, job_id);
CREATE TABLE IF NOT EXISTS analysis_removals (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  job_id text NOT NULL,
  rows_left integer NOT NULL CHECK (rows_left > 0),
  PRIMARY KEY (space_id, collection_id, job_id),
  FOREIGN KEY (space_id, collection_id, job_id) REFERENCES analysis_jobs(space_id, collection_id, job_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analysis_removals_order ON analysis_removals(rows_left, job_id);
REVOKE ALL ON portability_removals, analysis_removals FROM PUBLIC;

-- Owner rights, so whoever ends a job (an owner's cancellation or a worker)
-- queues its removal without a grant on the queue.
CREATE OR REPLACE FUNCTION stateplane_queue_removal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  last integer;
BEGIN
  IF TG_TABLE_NAME = 'portability_jobs' THEN
    SELECT max(p.part_number) INTO last FROM public.portability_parts p WHERE p.space_id = NEW.space_id AND p.job_id = NEW.job_id;
    IF last IS NOT NULL THEN
      INSERT INTO public.portability_removals(space_id, job_id, rows_left) VALUES (NEW.space_id, NEW.job_id, last)
        ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    SELECT max(p.page_number) INTO last FROM public.analysis_result_pages p
      WHERE p.space_id = NEW.space_id AND p.collection_id = NEW.collection_id AND p.job_id = NEW.job_id;
    IF last IS NOT NULL THEN
      INSERT INTO public.analysis_removals(space_id, collection_id, job_id, rows_left)
        VALUES (NEW.space_id, NEW.collection_id, NEW.job_id, last) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_queue_removal() FROM PUBLIC;
CREATE OR REPLACE TRIGGER portability_jobs_removal AFTER UPDATE OF state ON portability_jobs FOR EACH ROW
  WHEN (NEW.kind = 'export' AND NEW.state IN ('cancelled', 'failed', 'expired') AND OLD.state NOT IN ('cancelled', 'failed', 'expired'))
  EXECUTE FUNCTION stateplane_queue_removal();
CREATE OR REPLACE TRIGGER analysis_jobs_removal AFTER UPDATE OF state ON analysis_jobs FOR EACH ROW
  WHEN (NEW.state IN ('cancelled', 'failed', 'expired') AND OLD.state NOT IN ('cancelled', 'failed', 'expired'))
  EXECUTE FUNCTION stateplane_queue_removal();

-- The same step's turn order (docs/portability-export.md#worker): when a step
-- has room for one turn only, the kind this row names goes first and the step
-- names the other, so analysis jobs and exports alternate across steps,
-- whichever worker (a new one each tick) runs them.
CREATE TABLE IF NOT EXISTS snapshot_step_turn (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  exports_next boolean NOT NULL DEFAULT false
);
INSERT INTO snapshot_step_turn DEFAULT VALUES ON CONFLICT DO NOTHING;
