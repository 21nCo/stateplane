-- Preserve migration 004's instant key while removing its superseded text index.
DROP INDEX record_index_time;

-- Claim workers always filter by space and collection before due state/time.
DROP INDEX projection_outbox_claim;
CREATE INDEX projection_outbox_claim ON projection_outbox
  (space_id, collection_id, delivery_state, available_at, event_id)
  WHERE delivery_state IN ('pending', 'delivering', 'degraded');
