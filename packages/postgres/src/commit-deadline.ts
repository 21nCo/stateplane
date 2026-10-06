import type pg from 'pg';

/** COMMIT was sent, but its acknowledgement did not arrive before the budget. */
export class CommitDeadlineExceeded extends Error {
  constructor() { super('COMMIT acknowledgement exceeded the request deadline'); }
}
export class CommitNotSentDeadlineExceeded extends Error {
  constructor() { super('COMMIT deadline expired before dispatch'); }
}

/** A timed-out COMMIT may still succeed; the caller must discard its client. */
export async function commitBeforeDeadline(client:Pick<pg.PoolClient,'query'>,deadline:number):Promise<void> {
  const remaining=deadline-Date.now();
  if (remaining<=0) throw new CommitNotSentDeadlineExceeded();
  const committed=client.query('COMMIT');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timed=new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new CommitDeadlineExceeded()),remaining);
  });
  try { await Promise.race([committed,timed]); }
  finally {
    if (timer) clearTimeout(timer);
    // The database may answer after the timer; consume its late rejection.
    void committed.catch(()=>{});
  }
}
