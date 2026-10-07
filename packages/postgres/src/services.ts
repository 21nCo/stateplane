import type pg from 'pg';
import type { StateplaneServices } from '@stateplane/application';
import type { Capability, VerifiedCredential } from '@stateplane/contracts';
import { AuthorityError, PostgresAuthority } from './index.js';
import type { AuthorityScope } from './index.js';
import { CollectionRegistry } from './collections.js';
import { PostgresSpaces } from './spaces.js';

export interface ServiceCell { pool: Pick<pg.Pool,'connect'>; cursorSecret: Uint8Array }

/** Composition of the existing authoritative services for HTTP consumers. */
export function postgresServices(spaces: PostgresSpaces, cells: ReadonlyMap<string,ServiceCell>,
  receiptRetentionSeconds: number): StateplaneServices {
  async function admitted<T>(actor:VerifiedCredential,spaceId:string,collectionId:string|undefined,
    capability:Capability,run:(pool:ServiceCell,scope:AuthorityScope,recheck:(db:pg.PoolClient,result?:unknown)=>Promise<void>)=>Promise<T>,
    discoveryCollectionId?:string):Promise<T> {
    const admitted=await spaces.scope(actor,spaceId,collectionId,capability);
    const cell=cells.get(admitted.cellId);
    if (!cell) throw new AuthorityError('STALE_PLACEMENT');
    return run(cell,admitted.scope,async(db,result)=>{
      const discovery=collectionId===undefined && capability==='records:read';
      const grants:Capability[]=discovery ? ['records:read','schema:write'] : [capability];
      if (discovery && Array.isArray(result)) {
        await spaces.assertDiscoveryCurrent(actor,admitted.ownerPrincipalId,admitted.scope,db,
          result.map(entry=>entry.definition.slug),grants);
      } else {
        await spaces.assertScopeCurrent(actor,admitted.ownerPrincipalId,admitted.scope,db,
          discoveryCollectionId??collectionId,grants);
      }
    });
  }
  const authority=(cell:ServiceCell,recheck:(db:pg.PoolClient,result?:unknown)=>Promise<void>)=>
    new PostgresAuthority(cell.pool,receiptRetentionSeconds,cell.cursorSecret,30_000,recheck);
  return {
    spaces: {
      list:actor=>spaces.list(actor), create:(actor,cellId,spaceId)=>spaces.create(actor,cellId,spaceId),
      get:(actor,id)=>spaces.get(actor,id),
      update:(actor,id,lifecycle)=>spaces.update(actor,id,lifecycle),
      delete:async(actor,id)=>{ await spaces.delete(actor,id); return {spaceId:id,deleted:true}; }
    },
    collections: {
      list:(actor,spaceId,collectionId)=>admitted(actor,spaceId,undefined,'records:read',async(cell,scope,recheck)=>{
        const entries=await new CollectionRegistry(cell.pool,recheck).discover(scope,collectionId);
        if (collectionId===undefined) return entries;
        const found=entries.find(item=>item.definition.slug===collectionId);
        if (!found) throw new AuthorityError('NOT_FOUND');
        return found;
      },collectionId),
      define:(actor,spaceId,collectionId,serialized)=>admitted(actor,spaceId,collectionId,'schema:write',
        (cell,scope,recheck)=>new CollectionRegistry(cell.pool,recheck).defineSerialized(scope,serialized)),
      revise:(actor,spaceId,collectionId,version,serialized)=>admitted(actor,spaceId,collectionId,'schema:write',
        (cell,scope,recheck)=>new CollectionRegistry(cell.pool,recheck).reviseSerialized(scope,version,serialized))
    },
    records: {
      get:(actor,spaceId,collectionId,id)=>admitted(actor,spaceId,collectionId,'records:read',
        (cell,scope,recheck)=>authority(cell,recheck).transaction(scope,tx=>tx.getRecord(id))),
      byKey:(actor,spaceId,collectionId,mode,key)=>admitted(actor,spaceId,collectionId,'records:read',
        (cell,scope,recheck)=>authority(cell,recheck).transaction(scope,tx=>tx.getByKey(mode,key))),
      mutate:(actor,spaceId,collectionId,serialized)=>admitted(actor,spaceId,collectionId,'records:write',
        (cell,scope,recheck)=>authority(cell,recheck).mutateSerializedRequest(scope,serialized)),
      query:(actor,spaceId,collectionId,serialized)=>admitted(actor,spaceId,collectionId,'records:read',
        (cell,scope,recheck)=>authority(cell,recheck).transaction(scope,tx=>tx.querySerializedPage(serialized))),
      count:(actor,spaceId,collectionId,serialized)=>admitted(actor,spaceId,collectionId,'records:read',
        (cell,scope,recheck)=>authority(cell,recheck).transaction(scope,tx=>tx.countSerializedRecords(serialized)))
    },
    batches: {
      ingest:(actor,spaceId,collectionId,key,serialized,retryFailed)=>admitted(actor,spaceId,collectionId,'records:write',
        (cell,scope,recheck)=>authority(cell,recheck).ingestSerializedBatch(scope,key,serialized,retryFailed)),
      progress:async(actor,spaceId,collectionId,key)=>{
        // Progress is also the recovery path for a write-only ingester. Try
        // each admitted capability through its own transaction and final
        // credential check; never turn a provider failure into a fallback.
        let reachedFinalCheck=false;
        try {
          return await admitted(actor,spaceId,collectionId,'records:read',
            (cell,scope,recheck)=>authority(cell,async(db,result)=>{
              reachedFinalCheck=true;
              await recheck(db,result);
            }).batchProgress(scope,key));
        } catch(error) {
          if (actor.kind!=='api-key' || reachedFinalCheck ||
            !(error instanceof AuthorityError) || error.code!=='FORBIDDEN') throw error;
          return admitted(actor,spaceId,collectionId,'records:write',
            (cell,scope,recheck)=>authority(cell,recheck).batchProgress(scope,key));
        }
      },
      cancel:(actor,spaceId,collectionId,key)=>admitted(actor,spaceId,collectionId,'records:write',
        (cell,scope,recheck)=>authority(cell,recheck).cancelBatch(scope,key))
    },
    events: {
      list:(actor,spaceId,collectionId,cursor)=>admitted(actor,spaceId,collectionId,'events:read',
        (cell,scope,recheck)=>authority(cell,recheck).transaction(scope,tx=>tx.events(cursor))),
      projection:(actor,spaceId,collectionId,id)=>admitted(actor,spaceId,collectionId,'records:read',
        (cell,scope,recheck)=>authority(cell,recheck).transaction(scope,tx=>tx.projection(id)))
    }
  };
}
