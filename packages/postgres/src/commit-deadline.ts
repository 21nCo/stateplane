import type pg from 'pg';
import { NativePromise, observe, race, startTimer, stopTimer, wallNow } from './intrinsics.js';

/** COMMIT was sent, but its acknowledgement did not arrive before the budget. */
export class CommitDeadlineExceeded extends Error {
  constructor() { super('COMMIT acknowledgement exceeded the request deadline'); }
}
export class CommitNotSentDeadlineExceeded extends Error {
  constructor() { super('COMMIT deadline expired before dispatch'); }
}

/**
 * A timed-out COMMIT may still succeed; the caller must discard its client.
 * `sent` runs just before COMMIT is handed to the client: a failure before it
 * committed nothing, and any failure from then on, a synchronous one from the
 * client's query included, leaves the outcome unknown. `deadline` is on
 * the caller's clock `now`, by default the load-time capture of `Date.now`; the
 * timer and race are load-time captures too (`./intrinsics.js`).
 */
export async function commitBeforeDeadline(client:Pick<pg.PoolClient,'query'>,deadline:number,sent:()=>void=()=>{},
  now:()=>number=wallNow):Promise<void> {
  const remaining=deadline-now();
  if (remaining<=0) throw new CommitNotSentDeadlineExceeded();
  sent();
  const committed=client.query('COMMIT');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timed=new NativePromise<never>((_,reject)=>{
    timer=startTimer(()=>reject(new CommitDeadlineExceeded()),remaining);
  });
  try { await race<unknown>([committed,timed]); }
  finally {
    stopTimer(timer);
    // The database may answer after the timer; consume its late rejection.
    observe(committed);
  }
}
