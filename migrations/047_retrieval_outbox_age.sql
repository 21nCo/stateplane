-- STA-45: status reads a collection's oldest pending evidence item through
-- this one row, however long its backlog. The index is built concurrently, as
-- the only statement of this file and outside any transaction, so evidence
-- writers and retrieval workers keep running while it scans a populated
-- outbox. The migrator drops an invalid index that an interrupted build left
-- and builds it again, and records this file only once the index is valid.
CREATE INDEX CONCURRENTLY IF NOT EXISTS retrieval_outbox_age ON retrieval_outbox(space_id, collection_id, enqueued_at)
  WHERE delivery_state = 'pending';
