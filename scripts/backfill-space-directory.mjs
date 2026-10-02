import pg from 'pg';
import { backfillDirectory } from './backfill-directory-core.mjs';
import { connectionOptions } from './db-connection.mjs';

const controlUrl=process.env.STATEPLANE_CONTROL_URL;
const cells=JSON.parse(process.env.STATEPLANE_CELL_URLS ?? '[]');
if (!controlUrl || !Array.isArray(cells) || cells.length===0 ||
  !cells.every(cell=>typeof cell.cellId==='string' && typeof cell.url==='string'))
  throw new Error('Set STATEPLANE_CONTROL_URL and STATEPLANE_CELL_URLS=[{"cellId":"...","url":"..."}]');
const control=new pg.Client(connectionOptions(controlUrl));
const sources=cells.map(({cellId,url})=>({cellId,client:new pg.Client(connectionOptions(url))}));
try {
  await Promise.all([control.connect(),...sources.map(source=>source.client.connect())]);
  const count=await backfillDirectory(control,sources);
  console.log(`Verified ${count} existing space placements in control`);
} finally {
  await Promise.allSettled([control.end(),...sources.map(source=>source.client.end())]);
}
