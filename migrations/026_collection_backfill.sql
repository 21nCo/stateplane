-- A resumable position belongs to each newly declared typed index.
ALTER TABLE collection_index_declarations ADD COLUMN backfill_after text;
