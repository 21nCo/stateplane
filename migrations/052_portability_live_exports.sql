-- STA-70: the jobs Worker's export step reads only live export jobs (queued,
-- running, or completed and not yet expired) in its due probe, claim and
-- expiry pass, while ended jobs stay until their space is erased (migration
-- 051). Live exports are bounded per space (docs/portability-export.md#budgets),
-- so this partial index keeps those reads off the retained history. No export
-- writer runs before this slice, so the table is empty or small when this
-- builds.
CREATE INDEX IF NOT EXISTS portability_jobs_live ON portability_jobs(leased_until)
  WHERE kind = 'export' AND state IN ('queued', 'running', 'completed');
