import type pg from 'pg';
import { NativePromise, race, settle, startTimer, stopTimer, wallNow } from './intrinsics.js';

/** COMMIT was sent, but its acknowledgement did not arrive before the budget. */
export class CommitDeadlineExceeded extends Error {
  constructor() { super('COMMIT acknowledgement exceeded the request deadline'); }
}
export class CommitNotSentDeadlineExceeded extends Error {
  constructor() { super('COMMIT deadline expired before dispatch'); }
}

/**
 * A timed-out COMMIT may still succeed; the caller must discard its client.
 * `sent` runs once COMMIT is dispatched, so a caller can tell a failure before
 * dispatch, which committed nothing, from an unknown outcome. `deadline` is on
 * the caller's clock `now`, by default the load-time capture of `Date.now`; the
 * timer and race are load-time captures too (`./intrinsics.js`).
 */
export async function commitBeforeDeadline(client:Pick<pg.PoolClient,'query'>,deadline:number,sent:()=>void=()=>{},
  now:()=>number=wallNow):Promise<void> {
  const remaining=deadline-now();
  if (remaining<=0) throw new CommitNotSentDeadlineExceeded();
  const committed=client.query('COMMIT');
  sent();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timed=new NativePromise<never>((_,reject)=>{
    timer=startTimer(()=>reject(new CommitDeadlineExceeded()),remaining);
  });
  try { await race<unknown>([committed,timed]); }
  finally {
    stopTimer(timer);
    // The database may answer after the timer; consume its late rejection.
    settle(committed,undefined,()=>{});
  }
}
