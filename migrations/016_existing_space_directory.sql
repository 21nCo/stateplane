-- A single-database upgrade must retain routing for spaces created before
-- the control directory existed. Multi-database installations copy these
-- verified rows from each cell into the control database before traffic.
INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,
  lifecycle,policy_version,placement_generation,created_at)
SELECT space_id,owner_principal_id,cell_id,storage_target_id,lifecycle,
  policy_version,placement_generation,created_at FROM spaces
ON CONFLICT (space_id) DO NOTHING;
