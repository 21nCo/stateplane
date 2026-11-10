-- STA-59: analysis and export jobs page a collection's records in record ID
-- byte order (COLLATE "C"), whatever the database's default collation, which
-- orders the primary key. This index lets each page start at its checkpoint
-- and stop at its limit instead of sorting the collection. It is built
-- concurrently, as the only statement of this file and outside any
-- transaction, so record writers keep running while it scans a populated
-- table; the migrator drops an invalid index an interrupted build left, builds
-- it again, and records this file only once the index is valid.
CREATE INDEX CONCURRENTLY IF NOT EXISTS records_byte_order ON records(space_id, collection_id, record_id COLLATE "C");
