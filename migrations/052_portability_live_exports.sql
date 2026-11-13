-- STA-70: the jobs Worker's export step reads only live export jobs (queued,
-- running, or completed and not yet expired) in its due probe, claim and
-- expiry pass, while ended jobs stay until their space is erased (migration
-- 051). Live exports are bounded per space (docs/portability-export.md#budgets),
-- so this partial index keeps those reads off the retained history. No export
-- writer runs before this slice, so the table is empty or small when this
-- builds.
CREATE INDEX IF NOT EXISTS portability_jobs_live ON portability_jobs(leased_until)
  WHERE kind = 'export' AND state IN ('queued', 'running', 'completed');

-- Submission counts its space's live exports, read by space through this
-- index, never through the space's retained ended history.
CREATE INDEX IF NOT EXISTS portability_jobs_live_space ON portability_jobs(space_id)
  WHERE kind = 'export' AND state IN ('queued', 'running', 'completed');

-- An ended export's parts are removed in committed batches, highest first, so
-- it still holds parts exactly while its part 1 is there. This index has one
-- entry per export holding parts (held exports are bounded per space), so the
-- step finds ended exports to remove, and submission counts those of its
-- space as held, without reading the parts themselves or the retained job
-- history.
CREATE INDEX IF NOT EXISTS portability_parts_held ON portability_parts(space_id, job_id)
  WHERE kind = 'export' AND part_number = 1;

-- The same step's turn order (docs/portability-export.md#worker): when a step
-- has room for one turn only, the kind this row names goes first and the step
-- names the other, so analysis jobs and exports alternate across steps,
-- whichever worker (a new one each tick) runs them.
CREATE TABLE IF NOT EXISTS snapshot_step_turn (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  exports_next boolean NOT NULL DEFAULT false
);
INSERT INTO snapshot_step_turn DEFAULT VALUES ON CONFLICT DO NOTHING;
