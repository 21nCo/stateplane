-- Migration 037 makes the commit-safe pending/feed indexes authoritative for
-- polling. Keep the historical 036 ledger entry intact for existing databases.
DROP INDEX IF EXISTS record_events_scoped_cursor;
