-- STA-45: the retrieval worker's claims take space/collection pairs with
-- pending work in turn, as a ring, from the pair after the last one a claim
-- served, across steps and workers. One sustained backlog therefore cannot
-- keep another pair's work from being served within a bounded number of
-- claims. Like outbox_dispatch_checkpoint, this one cell-local row holds
-- only a position: it names no content and is never space-scoped data.
CREATE TABLE retrieval_dispatch_checkpoint (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  after_space_id text,
  after_collection_id text,
  CHECK ((after_space_id IS NULL) = (after_collection_id IS NULL))
);
INSERT INTO retrieval_dispatch_checkpoint DEFAULT VALUES;

-- When each row's last_error was recorded. available_at is a schedule, not
-- an error time: a lease moves it and parking sets it to infinity. Rows that
-- held an error before this step keep a NULL time and rank as the oldest.
-- Each ALTER waits briefly for, then excludes, that table's users. They lock
-- projection_outbox before retrieval_outbox, the order space purges and
-- status reads use, and nothing here locks either earlier, so a purge in
-- flight finishes instead of forming a cycle with this step.
ALTER TABLE projection_outbox ADD COLUMN last_error_at timestamptz;
ALTER TABLE retrieval_outbox ADD COLUMN last_error_at timestamptz;

-- 045's guard, with the error's time among the delivery columns.
CREATE OR REPLACE FUNCTION stateplane_guard_retrieval_outbox() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  delivery text[] := ARRAY['delivery_state', 'attempts', 'available_at', 'delivered_at', 'last_error', 'last_error_at'];
BEGIN
  IF (to_jsonb(NEW) - delivery) IS DISTINCT FROM (to_jsonb(OLD) - delivery) OR OLD.delivery_state = 'delivered'
    OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'retrieval work changes only its pending delivery'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'retrieval_outbox_transition';
  END IF;
  RETURN NEW;
END;
$$;
