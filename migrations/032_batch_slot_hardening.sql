-- Keep the already-applied 030 checksum stable for existing batch ledgers.
ALTER FUNCTION public.stateplane_seed_write_slots() SET search_path = pg_catalog, public, pg_temp;
ALTER TABLE public.batch_items ADD CONSTRAINT batch_items_attempts_nonnegative CHECK (attempts >= 0);
