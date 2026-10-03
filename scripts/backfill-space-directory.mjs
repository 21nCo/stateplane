import pg from 'pg';
import { backfillDirectory } from './backfill-directory-core.mjs';
import { connectionOptions } from './db-connection.mjs';
import { readFile } from 'node:fs/promises';

const controlUrl=process.env.STATEPLANE_CONTROL_URL;
const cells=JSON.parse(process.env.STATEPLANE_CELL_URLS ?? '[]');
const environment=process.env.STATEPLANE_TOPOLOGY_ENV;
const topology=JSON.parse(await readFile(new URL('../deployment/topology.json',import.meta.url),'utf8'));
const expectedCellIds=topology.environments?.[environment]?.cells?.map(cell=>cell.id);
if (!controlUrl || !Array.isArray(cells) || cells.length===0 ||
  !cells.every(cell=>cell && typeof cell.cellId==='string' && typeof cell.url==='string') ||
  !expectedCellIds || expectedCellIds.length!==cells.length ||
  new Set(cells.map(cell=>cell.cellId)).size!==cells.length ||
  cells.some(cell=>!expectedCellIds.includes(cell.cellId)) ||
  process.env.STATEPLANE_BACKFILL_DIRECTORY_DRAINED!=='1')
  throw new Error('Set STATEPLANE_CONTROL_URL, complete STATEPLANE_CELL_URLS, STATEPLANE_TOPOLOGY_ENV and STATEPLANE_BACKFILL_DIRECTORY_DRAINED=1');
const control=new pg.Client(connectionOptions(controlUrl));
const sources=cells.map(({cellId,url})=>({cellId,client:new pg.Client(connectionOptions(url))}));
try {
  await Promise.all([control.connect(),...sources.map(source=>source.client.connect())]);
  const counts=await backfillDirectory(control,sources,{expectedCellIds,drained:true});
  console.log(`Copied ${counts.copied} placements; verified ${counts.existing} already present`);
} finally {
  await Promise.allSettled([control.end(),...sources.map(source=>source.client.end())]);
}
