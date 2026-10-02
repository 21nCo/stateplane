/** Copy pre-directory cell placements into control after draining owner traffic. */
export async function backfillDirectory(control, cells) {
  const seen=new Set();
  const rows=[];
  for (const {cellId,client} of cells) {
    if (!cellId || seen.has(cellId)) throw new Error('Duplicate or missing cell ID');
    seen.add(cellId);
    const result=await client.query(`SELECT space_id,owner_principal_id,cell_id,storage_target_id,
      lifecycle,policy_version,placement_generation,created_at FROM spaces ORDER BY space_id`);
    for (const row of result.rows) {
      if (row.cell_id!==cellId) throw new Error(`Cell placement mismatch for ${row.space_id}`);
      rows.push(row);
    }
  }
  await control.query('BEGIN');
  try {
    await control.query('SELECT pg_advisory_xact_lock(73006)');
    for (const row of rows) {
      const current=await control.query('SELECT * FROM space_directory WHERE space_id=$1 FOR UPDATE',[row.space_id]);
      if (current.rows[0]) {
        const found=current.rows[0];
        for (const key of ['owner_principal_id','cell_id','storage_target_id','lifecycle','policy_version','placement_generation']) {
          if (String(found[key])!==String(row[key])) throw new Error(`Directory mismatch for ${row.space_id}: ${key}`);
        }
      } else {
        await control.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,
          lifecycle,policy_version,placement_generation,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[row.space_id,row.owner_principal_id,row.cell_id,row.storage_target_id,
          row.lifecycle,row.policy_version,row.placement_generation,row.created_at]);
      }
    }
    await control.query('COMMIT');
  } catch (error) {
    await control.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return rows.length;
}
