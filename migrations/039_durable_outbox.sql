-- STA-12: SQL stays the durable job authority. Queue messages are only hints.
-- Take every table lock this step needs up front, in record writers' order
-- (space, collection, record, outbox), so a writer cannot deadlock with it.
-- The migrator bounds the wait; live writers or long readers fail it fast.
LOCK TABLE spaces, collections, records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE projection_outbox IN ACCESS EXCLUSIVE MODE;
-- New outbox columns have constant defaults or are NULL, so adding them does
-- not rewrite or scan the table. Their checks are NOT VALID for the same
-- reason: every existing row already satisfies them, and later writes are checked.
ALTER TABLE projection_outbox
  ADD COLUMN failures integer NOT NULL DEFAULT 0,
  ADD COLUMN started_attempt integer,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN outcome text;
ALTER TABLE projection_outbox
  ADD CONSTRAINT projection_outbox_failures CHECK (failures >= 0) NOT VALID,
  ADD CONSTRAINT projection_outbox_outcome CHECK (outcome IN ('applied', 'superseded')) NOT VALID,
  -- A dead letter stays degraded and sorts after every due row in the live
  -- claim index until an operator retries it.
  ADD CONSTRAINT projection_outbox_dead_letter CHECK (dead_lettered_at IS NULL OR
    (delivery_state = 'degraded' AND available_at = 'infinity')) NOT VALID;
-- The dispatcher counts unstarted dispatch leases to bound its lead over
-- consumers, and status samples failed rows wherever they are parked. Both
-- partial indexes are built in this drained step with one heap scan each.
CREATE INDEX projection_outbox_unstarted ON projection_outbox(available_at)
  WHERE delivery_state = 'delivering' AND started_attempt IS NULL;
CREATE INDEX projection_outbox_failed ON projection_outbox(space_id, collection_id, event_id)
  WHERE delivery_state IN ('pending','delivering','degraded') AND (failures>0 OR delivery_state='degraded');

-- The newest applied revision per ref. Work for an older revision, or work
-- captured under an earlier placement generation, can never move it backward.
CREATE TABLE projection_heads (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  record_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  deleted boolean NOT NULL,
  event_id text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, record_id),
  -- Checked at COMMIT, so a ref's first head takes no key-share lock on its
  -- record while apply runs, and record writes never wait for projection.
  FOREIGN KEY (space_id, collection_id, record_id) REFERENCES records(space_id, collection_id, record_id)
    DEFERRABLE INITIALLY DEFERRED
);

-- One cell-local dispatcher cursor rotates claims across space/collection
-- pairs so a long backlog cannot keep later spaces out of every tick.
CREATE TABLE outbox_dispatch_checkpoint (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  after_space_id text,
  after_collection_id text,
  dispatched_at timestamptz,
  CHECK ((after_space_id IS NULL) = (after_collection_id IS NULL))
);
INSERT INTO outbox_dispatch_checkpoint DEFAULT VALUES;

-- Within a space's share of one claim, collections take turns starting after
-- the collection of the space's last claimed turn, so a space with more
-- backlogged collections than its share still serves each of them in turn.
-- One row per space that has been dispatched, written by the claim under the
-- checkpoint lock after it key-share locks the space, as erasure locks the
-- space before this row and the outbox.
CREATE TABLE outbox_space_rotation (
  space_id text PRIMARY KEY REFERENCES spaces(space_id),
  after_collection_id text NOT NULL
);

-- Resumable, cancellable repair of one collection's projection heads.
CREATE TABLE projection_reconciliations (
  job_id text PRIMARY KEY CHECK (job_id ~ '^rcn_[0-9a-f-]{36}$'),
  space_id text NOT NULL,
  collection_id text NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'completed', 'cancelled')),
  -- A placement fence schedules its own repair; operators start the rest.
  cause text NOT NULL DEFAULT 'operator' CHECK (cause IN ('operator', 'placement')),
  after_record_id text,
  scanned bigint NOT NULL DEFAULT 0 CHECK (scanned >= 0),
  requeued bigint NOT NULL DEFAULT 0 CHECK (requeued >= 0),
  -- A step is one transaction under a row lock; this only orders fair turns.
  next_step_at timestamptz NOT NULL DEFAULT '-infinity',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id)
);
CREATE UNIQUE INDEX projection_reconciliations_running ON projection_reconciliations(space_id, collection_id)
  WHERE state = 'running';
CREATE INDEX projection_reconciliations_due ON projection_reconciliations(next_step_at, job_id)
  WHERE state = 'running';

-- Operator retries, reconciliations and cancellations are audit facts. Like
-- space audits they survive space erasure and contain IDs, not record content.
CREATE TABLE outbox_operator_audit (
  audit_id text PRIMARY KEY CHECK (audit_id ~ '^oba_[0-9a-f-]{36}$'),
  space_id text NOT NULL REFERENCES spaces(space_id),
  collection_id text,
  action text NOT NULL CHECK (action IN ('retry', 'reconcile', 'cancel')),
  operator text NOT NULL CHECK (operator <> '' AND octet_length(operator) <= 256),
  reason text NOT NULL CHECK (reason <> '' AND octet_length(reason) <= 1024),
  job_id text,
  affected bigint NOT NULL CHECK (affected >= 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX outbox_operator_audit_space ON outbox_operator_audit(space_id, recorded_at);
CREATE TRIGGER outbox_operator_audit_immutable BEFORE UPDATE OR DELETE ON outbox_operator_audit
  FOR EACH ROW EXECUTE FUNCTION reject_space_audit_change();
CREATE TRIGGER outbox_operator_audit_no_truncate BEFORE TRUNCATE ON outbox_operator_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_space_audit_change();

-- Space erasure removes projection state before the records it references.
CREATE OR REPLACE FUNCTION stateplane_purge_space(p_space_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.spaces WHERE space_id=p_space_id AND lifecycle='deleting' FOR UPDATE) THEN
    RAISE EXCEPTION 'space is not deleting';
  END IF;
  PERFORM set_config('stateplane.erasing_space', p_space_id, true);
  DELETE FROM public.batch_operations WHERE space_id=p_space_id;
  DELETE FROM public.projection_reconciliations WHERE space_id=p_space_id;
  DELETE FROM public.projection_heads WHERE space_id=p_space_id;
  DELETE FROM public.outbox_space_rotation WHERE space_id=p_space_id;
  DELETE FROM public.projection_outbox WHERE space_id=p_space_id;
  DELETE FROM public.receipt_reservation_scopes WHERE space_id=p_space_id;
  DELETE FROM public.receipt_reservations WHERE space_id=p_space_id;
  DELETE FROM public.idempotency_receipts WHERE space_id=p_space_id;
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
  UPDATE public.spaces SET lifecycle='deleted',policy_version=policy_version+1 WHERE space_id=p_space_id;
END;
$$;
