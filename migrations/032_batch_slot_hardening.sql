-- Keep the already-applied 030 checksum stable for existing batch ledgers.
ALTER FUNCTION public.stateplane_seed_write_slots() SET search_path = pg_catalog, public, pg_temp;
-- Adding the constraint must not validate an existing ledger while the short
-- DDL lock is held. A following migration validates after this one commits.
ALTER TABLE public.batch_items ADD CONSTRAINT batch_items_attempts_nonnegative CHECK (attempts >= 0) NOT VALID;
