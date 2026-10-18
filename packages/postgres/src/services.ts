import type pg from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { StateplaneServices } from '@stateplane/application';
import type { Capability, VerifiedCredential } from '@stateplane/contracts';
import { AuthorityError, PostgresAuthority } from './index.js';
import type { AuthorityScope } from './index.js';
import { CollectionRegistry, discoveryGrants } from './collections.js';
import { PostgresSpaces } from './spaces.js';
import type { CollectionGrant } from './spaces.js';

export interface ServiceCell { pool: Pick<pg.Pool,'connect'>; cursorSecret: Uint8Array }
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
  // A leap second is valid only at 23:59 UTC; Date cannot represent it, so use its last earlier millisecond.
  parsed.setUTCHours(hour,minute-offset,Math.min(second,59),second===60 ? 999 : Number((match[7]??'').padEnd(3,'0').slice(0,3)));
  const leapSecondMisplaced=second===60 && (parsed.getUTCHours()!==23 || parsed.getUTCMinutes()!==59);
  if (leapSecondMisplaced || parsed.getUTCFullYear()<0 || parsed.getUTCFullYear()>9999) throw new AuthorityError('INVALID_ARGUMENT');
  return parsed;
};
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
  return {
    spaces: {
      list:(actor,cursor)=>spaces.listPage(actor,cursor), create:(actor,cellId,spaceId)=>spaces.create(actor,cellId,spaceId),
      get:(actor,id)=>spaces.get(actor,id),
      update:(actor,id,lifecycle)=>spaces.update(actor,id,lifecycle),
      delete:async(actor,id)=>{ await spaces.delete(actor,id); return {spaceId:id,deleted:true}; },
      audit:(actor,id,cursor)=>spaces.audit(actor,id,cursor)
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
    }
  };
}
