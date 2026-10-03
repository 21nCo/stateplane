function requireCompleteSources(cells, expectedCellIds, drained) {
  const actual = cells?.map(cell => cell?.cellId);
  if (drained !== true || !Array.isArray(expectedCellIds) || expectedCellIds.length === 0 ||
    !Array.isArray(actual) || actual.length !== expectedCellIds.length ||
    new Set(actual).size !== actual.length || new Set(expectedCellIds).size !== expectedCellIds.length ||
    actual.some(id => typeof id !== 'string' || !expectedCellIds.includes(id)))
    throw new Error('Backfill requires drained traffic and every configured cell');
}

async function lockSources(cells, opened) {
  // Lock every source before reading any source. SHARE excludes placement
  // writers, and the locks survive through control publication.
  for (const { client } of cells) {
    await client.query('BEGIN'); opened.push(client);
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE spaces IN SHARE MODE');
  }
}

async function sourceRows(cells) {
  const rows = [];
  const seenSpaces = new Set();
  for (const { cellId, client } of cells) {
    const result = await client.query(`SELECT space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,
      lifecycle,policy_version,placement_generation,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM spaces ORDER BY space_id`);
    for (const row of result.rows) {
      if (row.cell_id !== cellId || seenSpaces.has(row.space_id)) throw new Error(`Cell placement mismatch for ${row.space_id}`);
      seenSpaces.add(row.space_id);
      rows.push(row);
    }
  }
  return rows;
}

async function copyRows(control, rows) {
  let copied = 0;
  let existing = 0;
  for (const row of rows) {
    const current = await control.query(`SELECT *,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_created_at
      FROM space_directory WHERE space_id=$1 FOR UPDATE`,[row.space_id]);
    if (current.rows[0]) {
      const found = current.rows[0];
      for (const key of ['owner_principal_id','cell_id','storage_target_id','lifecycle','policy_version','placement_generation']) {
        if (String(found[key]) !== String(row[key])) throw new Error(`Directory mismatch for ${row.space_id}: ${key}`);
      }
      if (found.home_cell_id === null) {
        await control.query('UPDATE space_directory SET home_cell_id=$2 WHERE space_id=$1',
          [row.space_id,row.home_cell_id]);
      } else if (found.home_cell_id !== row.home_cell_id) {
        throw new Error(`Directory mismatch for ${row.space_id}: home_cell_id`);
      }
      if (found.precise_created_at !== row.created_at) throw new Error(`Directory mismatch for ${row.space_id}: created_at`);
      existing++;
    } else {
      await control.query(`INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,
        lifecycle,policy_version,placement_generation,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)`,[row.space_id,row.owner_principal_id,row.home_cell_id,row.cell_id,row.storage_target_id,
        row.lifecycle,row.policy_version,row.placement_generation,row.created_at]);
      copied++;
    }
  }
  return { copied, existing };
}

/** Offline copy of every configured cell into the control directory. */
export async function backfillDirectory(control, cells, { expectedCellIds, drained } = {}) {
  requireCompleteSources(cells,expectedCellIds,drained);
  const opened = [];
  let controlOpen = false;
  try {
    await control.query('BEGIN'); controlOpen = true;
    await control.query('SELECT pg_advisory_xact_lock(73006)');
    await lockSources(cells,opened);
    const counts = await copyRows(control,await sourceRows(cells));
    await control.query('COMMIT'); controlOpen = false;
    return counts;
  } catch (error) {
    if (controlOpen) await control.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled(opened.map(client => client.query('ROLLBACK')));
  }
}
