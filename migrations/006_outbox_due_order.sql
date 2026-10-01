-- The partial predicate already limits live delivery states; key due time next
-- so a scoped claim can read in lease order without sorting across states.
DROP INDEX projection_outbox_claim;
CREATE INDEX projection_outbox_claim ON projection_outbox
  (space_id, collection_id, available_at, event_id)
  WHERE delivery_state IN ('pending', 'delivering', 'degraded');
