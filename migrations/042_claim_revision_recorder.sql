-- STA-35: each claim revision names the principal that recorded it. The
-- claim's creator is `claims.principal_id`, but a revision or review can come
-- from another principal, and the credential alone does not name one for an
-- owner session, so the principal is stored with the revision.
-- Revisions are immutable and no service wrote claims before this step, so
-- the column is added without a backfill and the rule binds every new row
-- without a scan; a fixture revision stored earlier reads as unrecorded.
ALTER TABLE claim_revisions ADD COLUMN recorded_by text;
-- A review revision is recorded by its reviewer.
ALTER TABLE claim_revisions ADD CONSTRAINT claim_revisions_recorded_by
  CHECK (recorded_by IS NOT NULL AND char_length(recorded_by) > 0
    AND (review_status = 'unreviewed' OR recorded_by = reviewed_by)) NOT VALID;
