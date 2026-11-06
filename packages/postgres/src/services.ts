import type pg from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BlobStore, StateplaneServices } from '@stateplane/application';
import type { Capability, VerifiedCredential } from '@stateplane/contracts';
import type { EmbeddingRegistry } from '@stateplane/retrieval';
import { AuthorityError, AuthorityTransaction, PostgresAuthority } from './index.js';
import { PostgresAggregations } from './aggregations.js';
import type { AggregationCell } from './aggregations.js';
import { PostgresContextBundles } from './bundles.js';
import { generationViews } from './generations.js';
import { PostgresRetrievalWorker } from './retrieval.js';
import { PostgresRetrievalSearch } from './search.js';
import { PostgresClaims } from './claims.js';
import { PostgresLinks } from './links.js';
import { PostgresSources, transact } from './sources.js';
import type { AuthorityScope } from './index.js';
import { CollectionRegistry, discoveryGrants } from './collections.js';
import { PostgresSpaces } from './spaces.js';
import { utcInstant } from './schema.js';
import type { CollectionGrant } from './spaces.js';

/** `originals` is the cell's blob store, such as its R2 `ORIGINALS` binding. Without it, source
 * metadata, claims and links still work, and every operation that needs original bytes fails
 * with nonretryable PROVIDER_UNAVAILABLE. `analytics` is the cell's analytical pool, a pool of
 * its own apart from `pool`, and its origin connection limit; aggregations run only there (and
 * are authorized on `pool` first). Without it, every aggregation fails with nonretryable
 * PROVIDER_UNAVAILABLE rather than take capacity interactive reads rely on. */
export interface ServiceCell { pool: Pick<pg.Pool,'connect'>; cursorSecret: Uint8Array; originals?: BlobStore;
  analytics?: Omit<AggregationCell,'admission'> }
const unconfigured=():Promise<never>=>Promise.reject(new AuthorityError('PROVIDER_UNAVAILABLE',
  'Original storage is not configured',undefined,false));
const noOriginals:BlobStore={put:unconfigured,head:unconfigured,get:unconfigured,delete:unconfigured,list:unconfigured};
const collectionPageSize=8;
const cursorMac=(space:string,credential:string,after:string,secret:Uint8Array):string=>
  createHmac('sha256',secret).update(JSON.stringify({space,credential,after})).digest('hex');
function discoveryAfter(cursor:string|undefined,spaceId:string,credentialId:string,secret:Uint8Array):string {
  if (cursor===undefined) return '';
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw new AuthorityError('CURSOR_INVALID');
  try {
    const decoded=Buffer.from(cursor,'base64url').toString('utf8');
    const value=JSON.parse(decoded) as {space?:unknown;credential?:unknown;after?:unknown;mac?:unknown};
    if (!value || typeof value!=='object' || Object.keys(value).length!==4 ||
      Buffer.from(decoded).toString('base64url')!==cursor || value.space!==spaceId ||
      value.credential!==credentialId || typeof value.after!=='string' || !value.after ||
      Buffer.byteLength(value.after)>512 || typeof value.mac!=='string' || !/^[0-9a-f]{64}$/.test(value.mac) ||
      !timingSafeEqual(Buffer.from(value.mac),Buffer.from(cursorMac(spaceId,credentialId,value.after,secret))))
      throw new Error('invalid');
    return value.after;
  } catch { throw new AuthorityError('CURSOR_INVALID'); }
}
const discoveryCursor=(space:string,credential:string,after:string,secret:Uint8Array):string=>
  Buffer.from(JSON.stringify({space,credential,after,mac:cursorMac(space,credential,after,secret)})).toString('base64url');

// RFC 3339 date-time (OpenAPI format: date-time): seconds required, any fraction, Z or a numeric offset.
const dateTime=/^(\d{4})-(\d\d)-(\d\d)[Tt](\d\d):(\d\d):(\d\d)(?:\.(\d+))?(?:[Zz]|([+-])(\d\d):(\d\d))$/;
const monthDays=[31,28,31,30,31,30,31,31,30,31,30,31];
function calendarFields(year:number,month:number,day:number,hour:number,minute:number,second:number):boolean {
  const leap=year%4===0 && (year%100!==0 || year%400===0);
  return month>=1 && month<=12 && day>=1 && day<=(month===2 && leap ? 29 : monthDays[month-1]) &&
    hour<=23 && minute<=59 && second<=60;
}
/** Normalize an RFC 3339 expiry to a UTC millisecond. Extra fraction digits are
 * truncated, so a normalized expiry is never later than the one requested. */
const instant=(value:unknown):Date=>{
  const match=typeof value==='string' ? dateTime.exec(value) : null;
  if (!match) throw new AuthorityError('INVALID_ARGUMENT');
  const [year,month,day,hour,minute,second,offsetHour,offsetMinute]=[...match.slice(1,7),...match.slice(9,11)].map(field=>Number(field??0));
  if (!calendarFields(year,month,day,hour,minute,second) || offsetHour>23 || offsetMinute>59) throw new AuthorityError('INVALID_ARGUMENT');
  const offset=(match[8]==='-' ? -1 : 1)*(offsetHour*60+offsetMinute);
  const parsed=new Date(0);
  parsed.setUTCFullYear(year,month-1,day);
  // Date cannot represent a leap second, so use its last earlier millisecond.
  parsed.setUTCHours(hour,minute-offset,Math.min(second,59),second===60 ? 999 : Number((match[7]??'').padEnd(3,'0').slice(0,3)));
  if (parsed.getUTCFullYear()<0 || parsed.getUTCFullYear()>9999 || (second===60 && !leapSecond(parsed))) throw new AuthorityError('INVALID_ARGUMENT');
  return parsed;
};
/** A leap second is valid only at 23:59:60 UTC on a known leap-second date, as for record date-times. */
function leapSecond(parsed:Date):boolean {
  const utc=parsed.toISOString();
  if (utc.slice(11,19)!=='23:59:59') return false;
  try { utcInstant(`${utc.slice(0,10)}T23:59:60Z`); return true; } catch { return false; }
}
const plain=(value:unknown,keys:readonly string[],required:readonly string[]):Record<string,unknown>=>{
  if (!value || typeof value!=='object' || Array.isArray(value) ||
    Object.keys(value).some(key=>!keys.includes(key)) || required.some(key=>!Object.hasOwn(value,key)))
    throw new AuthorityError('INVALID_ARGUMENT');
  return value as Record<string,unknown>;
};
/** Parse the JSON issuance body; PostgresSpaces validates collections and capabilities. */
function issueRequest(serialized:string):{expiresAt:Date;grants:CollectionGrant[]} {
  let parsed:unknown;
  try { parsed=JSON.parse(serialized); } catch { throw new AuthorityError('INVALID_ARGUMENT'); }
  const body=plain(parsed,['expiresAt','grants'],['expiresAt','grants']);
  if (!Array.isArray(body.grants)) throw new AuthorityError('INVALID_ARGUMENT');
  return {expiresAt:instant(body.expiresAt),grants:body.grants.map(item=>{
    const grant=plain(item,['collectionId','capabilities','expiresAt'],['collectionId','capabilities']);
    return {collectionId:grant.collectionId as string,capabilities:grant.capabilities as Capability[],
      ...(grant.expiresAt===undefined ? {} : {expiresAt:instant(grant.expiresAt)})};
  })};
}

/** Optional retrieval wiring. Without embedders (the default), search and bundles answer lexically and say so. */
export interface ServiceOptions { embedders?: EmbeddingRegistry }

/**
 * Owner only: a collection's projection work and generations. These are
 * derived, operational facts (counts, states, embedder identities), never
 * content, and include work on Refs a key could not read, so no key reads
 * them; a key sees the state of what it may read in each search's
 * `collections[]`. The scope fence (space open at the admitted policy and
 * placement, collection live, owner session current) runs before and after
 * the projection reads, so a deletion, suspension or ended session committed
 * before the answer refuses it; as for search, the session's own expiry must
 * still lie ahead once the trailing fence's COMMIT is acknowledged. The work,
 * generations and pending rebuild are read in one snapshot.
 */
function projectionStatus(spaces:PostgresSpaces,cells:ReadonlyMap<string,ServiceCell>,options:ServiceOptions) {
  return async(actor:VerifiedCredential,spaceId:string,collectionId:string)=>{
    const admitted=await spaces.scope(actor,spaceId,collectionId,'records:read');
    if (actor.kind!=='session') throw new AuthorityError('FORBIDDEN');
    const cell=cells.get(admitted.cellId);
    if (!cell) throw new AuthorityError('STALE_PLACEMENT');
    const fence=async()=>{
      // The provider's expiry on performance.now()'s clock (measured from before the check) and on its own wall clock.
      const started=performance.now(), wall=Date.now();
      const until=await transact(cell.pool,async db=>{
        const tx=new AuthorityTransaction(db,admitted.scope,1);
        try {
          await tx.checkScope();
          return await spaces.assertCurrentUntil(actor,admitted.ownerPrincipalId);
        } finally { tx.close(); }
      });
      if (until!==null && (performance.now()>=started+until-wall || Date.now()>=until))
        throw new AuthorityError('FORBIDDEN','Access expired before the status committed');
    };
    await fence();
    const worker=new PostgresRetrievalWorker(cell.pool,{embedders:options.embedders});
    const {status,pending}=await transact(cell.pool,async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return {status:await worker.status(spaceId,collectionId,db),
        pending:await generationViews(db.query.bind(db),spaceId,collectionId,true)};
    });
    await fence();
    return {...status,rebuild:pending[0] ?? null};
  };
}

/** Composition of the existing authoritative services for HTTP consumers. */
export function postgresServices(spaces: PostgresSpaces, cells: ReadonlyMap<string,ServiceCell>,
  receiptRetentionSeconds: number, options: ServiceOptions = {}): StateplaneServices {
  async function admitted<T>(actor:VerifiedCredential,spaceId:string,collectionId:string|undefined,
    capability:Capability,run:(pool:ServiceCell,scope:AuthorityScope,recheck:(db:pg.PoolClient,result?:unknown)=>Promise<void>)=>Promise<T>,
    discoveryCollectionId?:string):Promise<T> {
    const admitted=await spaces.scope(actor,spaceId,collectionId,capability);
    const cell=cells.get(admitted.cellId);
    if (!cell) throw new AuthorityError('STALE_PLACEMENT');
    return run(cell,admitted.scope,async(db,result)=>{
      const discovery=collectionId===undefined && capability==='records:read';
      const grants:readonly Capability[]=discovery ? discoveryGrants(capability) : [capability];
      const discovered=result && typeof result==='object' && 'items' in result ? result.items : result;
      if (discovery && Array.isArray(discovered)) {
        await spaces.assertDiscoveryCurrent(actor,admitted.ownerPrincipalId,admitted.scope,db,
          discovered.map(entry=>entry.definition.slug),grants);
      } else {
        await spaces.assertScopeCurrent(actor,admitted.ownerPrincipalId,admitted.scope,db,
          discoveryCollectionId??collectionId,grants);
      }
    });
  }
  const authority=(cell:ServiceCell,recheck:(db:pg.PoolClient,result?:unknown)=>Promise<void>)=>
    new PostgresAuthority(cell.pool,receiptRetentionSeconds,cell.cursorSecret,30_000,recheck);
  // Evidence services admit, authorize and recheck every call themselves, as their direct callers do.
  const evidenceCells=new Map([...cells].map(([id,cell])=>[id,{pool:cell.pool,originals:cell.originals??noOriginals}]));
  const sources=new PostgresSources(spaces,evidenceCells);
  const claims=new PostgresClaims(spaces,evidenceCells);
  const links=new PostgresLinks(spaces,evidenceCells);
  // Search admits, rereads and reauthorizes every hit itself; a bundle quotes only what one search returned.
  const search=new PostgresRetrievalSearch(spaces,new Map([...cells].map(([id,cell])=>[id,{pool:cell.pool}])),
    options.embedders ? {embedders:options.embedders} : {});
  const bundles=new PostgresContextBundles(search);
  // Aggregations admit, bound and recheck every call themselves, on each cell's analytical pool and slots only.
  const analytical=new Map<string,AggregationCell>();
  for (const [id,cell] of cells) if (cell.analytics) {
    if (cell.analytics.pool===cell.pool) throw new Error(`Cell ${id} needs an analytical pool apart from its interactive pool`);
    analytical.set(id,{pool:cell.analytics.pool,originConnectionLimit:cell.analytics.originConnectionLimit,admission:cell.pool});
  }
  const aggregations=new PostgresAggregations(spaces,analytical);
  return {
    spaces: {
      list:(actor,cursor)=>spaces.listPage(actor,cursor), create:(actor,cellId,spaceId)=>spaces.create(actor,cellId,spaceId),
      get:(actor,id)=>spaces.get(actor,id),
      update:(actor,id,lifecycle)=>spaces.update(actor,id,lifecycle),
      // Deleted is not erased: the report says what the cell's blob store and backups may still hold. The deletion has
      // committed before the report is read, so a failed read reports everything pending rather than a failed delete.
      delete:async(actor,id)=>{
        await spaces.delete(actor,id);
        const erasure=await spaces.erasure(actor,id).catch(()=>({spaceId:id,database:'pending' as const,
          originalBytes:'pending' as const,backups:'retained' as const}));
        return {spaceId:id,deleted:true,erasure};
      },
      audit:(actor,id,cursor)=>spaces.audit(actor,id,cursor),
      erasure:(actor,id)=>spaces.erasure(actor,id)
    },
    sources: {
      get:(actor,s,c,id)=>sources.get(actor,s,c,id), content:(actor,s,c,id)=>sources.content(actor,s,c,id),
      ingestText:(actor,s,c,request)=>sources.ingestText(actor,s,c,request),
      ingestReference:(actor,s,c,request)=>sources.ingestReference(actor,s,c,request),
      createUpload:(actor,s,c,request)=>sources.createUpload(actor,s,c,request),
      upload:(actor,s,c,grantId,body,declared)=>sources.upload(actor,s,c,grantId,body,declared),
      finalizeUpload:(actor,s,c,grantId,request)=>sources.finalizeUpload(actor,s,c,grantId,request),
      revokeUpload:(actor,s,c,grantId)=>sources.revokeUpload(actor,s,c,grantId),
      delete:(actor,s,c,id)=>sources.delete(actor,s,c,id), extract:(actor,s,c,id)=>sources.extract(actor,s,c,id),
      correctExtraction:(actor,s,c,id,request)=>sources.correctExtraction(actor,s,c,id,request),
      extraction:(actor,s,c,id,version)=>sources.extraction(actor,s,c,id,version)
    },
    claims: {
      create:(actor,s,c,request)=>claims.create(actor,s,c,request),
      revise:(actor,s,c,id,request)=>claims.revise(actor,s,c,id,request),
      review:(actor,s,c,id,request)=>claims.review(actor,s,c,id,request),
      delete:(actor,s,c,id,request)=>claims.delete(actor,s,c,id,request),
      get:(actor,s,c,id,revision)=>claims.get(actor,s,c,id,revision), list:(actor,s,c,query)=>claims.list(actor,s,c,query)
    },
    links: {
      create:(actor,s,c,request)=>links.create(actor,s,c,request), get:(actor,s,c,id)=>links.get(actor,s,c,id),
      delete:(actor,s,c,id)=>links.delete(actor,s,c,id), list:(actor,s,c,query)=>links.list(actor,s,c,query)
    },
    agents: {
      list:(actor,spaceId,cursor)=>spaces.agentKeys(actor,spaceId,cursor),
      issue:async(actor,spaceId,serialized)=>{
        const {expiresAt,grants}=issueRequest(serialized);
        const key=await spaces.issueAgentKey(actor,spaceId,expiresAt,grants);
        return {keyId:key.id,secret:key.secret,expiresAt:expiresAt.toISOString()};
      },
      revoke:async(actor,spaceId,keyId)=>{ await spaces.revokeAgentKey(actor,spaceId,keyId); return {keyId,revoked:true}; }
    },
    collections: {
      list:(actor,spaceId,collectionId,cursor)=>admitted(actor,spaceId,undefined,'records:read',async(cell,scope,recheck)=>{
        const after=collectionId===undefined ? discoveryAfter(cursor,spaceId,actor.credentialId,cell.cursorSecret) : '';
        const entries=await new CollectionRegistry(cell.pool,recheck).discover(scope,collectionId,after);
        if (collectionId===undefined) {
          const items=entries.slice(0,collectionPageSize);
          return {items,cursor:entries.length>collectionPageSize ?
            discoveryCursor(spaceId,actor.credentialId,items.at(-1)!.definition.slug,cell.cursorSecret) : null};
        }
        const found=entries.find(item=>item.definition.slug===collectionId);
        if (!found) throw new AuthorityError('NOT_FOUND');
        return found;
      },collectionId),
      define:(actor,spaceId,collectionId,serialized)=>admitted(actor,spaceId,collectionId,'schema:write',
        (cell,scope,recheck)=>new CollectionRegistry(cell.pool,recheck).defineSerialized(scope,serialized)),
      revise:(actor,spaceId,collectionId,version,serialized)=>admitted(actor,spaceId,collectionId,'schema:write',
        (cell,scope,recheck)=>new CollectionRegistry(cell.pool,recheck).reviseSerialized(scope,version,serialized)),
      backfill:(actor,spaceId,collectionId,field)=>admitted(actor,spaceId,collectionId,'schema:write',
        (cell,scope,recheck)=>new CollectionRegistry(cell.pool,recheck).backfill(scope,field))
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
    },
    retrieval: {
      search:(actor,spaceId,request)=>search.search(actor,spaceId,request),
      bundle:(actor,spaceId,request)=>bundles.bundle(actor,spaceId,request),
      status:projectionStatus(spaces,cells,options)
    },
    analysis: {
      aggregate:(actor,spaceId,collectionId,serialized)=>aggregations.aggregateSerialized(actor,spaceId,collectionId,serialized)
    }
  };
}
