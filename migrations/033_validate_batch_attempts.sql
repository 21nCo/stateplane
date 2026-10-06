-- VALIDATE CONSTRAINT uses SHARE UPDATE EXCLUSIVE, allowing batch inserts and
-- updates to continue while it scans historical items. The runner commits 032
-- before starting this migration so its ADD CONSTRAINT lock is released.
ALTER TABLE public.batch_items VALIDATE CONSTRAINT batch_items_attempts_nonnegative;
