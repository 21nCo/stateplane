-- Existing split control databases have no cell rows to infer a stable home.
-- They remain unfilled until the drained cross-database backfill verifies them.
ALTER TABLE space_directory ADD COLUMN home_cell_id text;
ALTER TABLE space_directory ADD CONSTRAINT space_directory_home_cell_nonempty
  CHECK (home_cell_id IS NULL OR home_cell_id <> '');
UPDATE space_directory d SET home_cell_id=s.home_cell_id
  FROM spaces s WHERE d.space_id=s.space_id
    AND d.owner_principal_id=s.owner_principal_id
    AND d.cell_id=s.cell_id AND d.storage_target_id=s.storage_target_id;
