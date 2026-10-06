-- The v1 event feed paginates immutable metadata by committed time and ID.
-- Apply during a drained writer window on a populated authority database.
CREATE INDEX record_events_scoped_cursor
  ON record_events(space_id, collection_id, committed_at, event_id);
