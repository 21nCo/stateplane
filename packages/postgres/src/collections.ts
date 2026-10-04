import type pg from 'pg';
import { AuthorityError, type AuthorityScope } from './index.js';
import { canonical, compatible, derivedValues, plainJson, scalarString, validateDefinition } from './schema.js';
import type { CollectionDefinition, Json } from './schema.js';

type PoolLike = Pick<pg.Pool,'connect'>;
type Client = pg.PoolClient;
const validVersion=(n:unknown)=>Number.isSafeInteger(n) && (n as number)>0;
const has=(values:readonly string[],value:string)=>{ for (let i=0;i<values.length;i++) if (Object.getOwnPropertyDescriptor(values,i)?.value===value) return true; return false; };
const append=<T>(values:T[],value:T)=>{ Object.defineProperty(values,values.length,{value,writable:true,configurable:true,enumerable:true}); };
const snapshotDefinition=(input:unknown):(()=>unknown)=>{
  try {
    plainJson(input,'SCHEMA_UNSUPPORTED');
    const fixed=JSON.parse(canonical(input as Json));
    return ()=>fixed;
  } catch (error) {
    // Keep malformed input detached, but retain the authorization boundary.
    return ()=>{ throw error; };
  }
};

/** Schema administration and explicit index activation in the regional authority. */
export class CollectionRegistry {
  constructor(private readonly pool: PoolLike) {}
  private async transaction<T>(fn:(client:Client)=>Promise<T>):Promise<T> {
    const client=await this.pool.connect();
    let begun=false,discard=false;
    try {
      await client.query('BEGIN'); begun=true;
      const result=await fn(client);
      try { await client.query('COMMIT'); begun=false; }
      catch (error) { discard=true; throw error; }
      return result;
    } catch (error) {
      if (begun) try { await client.query('ROLLBACK'); } catch { discard=true; }
      throw error;
    } finally { client.release(discard); }
  }
  private async authorize(client:Client,scope:AuthorityScope,collectionId:string,create=false):Promise<void> {
    if (scope.capability!=='schema:write') throw new AuthorityError('FORBIDDEN');
    const result=await client.query(`SELECT s.owner_principal_id,s.lifecycle,s.policy_version,s.placement_generation,
      c.lifecycle AS collection_lifecycle,g.capabilities,
      (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AS grant_current
      FROM spaces s LEFT JOIN collections c ON c.space_id=s.space_id AND c.collection_id=$2
      LEFT JOIN collection_grants g ON g.space_id=s.space_id AND g.collection_id=c.collection_id AND g.credential_id=$3
      WHERE s.space_id=$1 FOR SHARE OF s`,[scope.spaceId,collectionId,scope.credentialId]);
    const row=result.rows[0];
    if (!row) throw new AuthorityError('NOT_FOUND');
    if (Number(row.policy_version)!==scope.policyVersion || Number(row.placement_generation)!==scope.placementGeneration) throw new AuthorityError('FORBIDDEN');
    if (row.lifecycle!=='active' || (row.collection_lifecycle && row.collection_lifecycle!=='active')) throw new AuthorityError('SPACE_UNAVAILABLE');
    if (create ? row.owner_principal_id!==scope.principalId : row.owner_principal_id!==scope.principalId &&
      (!Array.isArray(row.capabilities) || !has(row.capabilities,'schema:write') || !row.grant_current)) throw new AuthorityError('FORBIDDEN');
  }
  private async insertDeclarations(client:Client,scope:AuthorityScope,definition:CollectionDefinition,previous?:CollectionDefinition):Promise<void> {
    if (!previous) for (let i=0;i<definition.unique.length;i++) {
      const item=definition.unique[i];
      await client.query(`INSERT INTO collection_unique_declarations
        (space_id,collection_id,constraint_name,paths,accepted_version) VALUES($1,$2,$3,$4,$5)`,
      [scope.spaceId,definition.slug,item.name,item.paths,definition.version]);
    }
    const old:string[]=[];
    const previousPaths=[previous?.filterable??[],previous?.sortable??[]];
    for (let j=0;j<previousPaths.length;j++) for (let i=0;i<previousPaths[j].length;i++) append(old,previousPaths[j][i]);
    const fields:string[]=[];
    const declaredPaths=[definition.filterable,definition.sortable];
    for (let j=0;j<declaredPaths.length;j++) {
      const paths=declaredPaths[j];
      for (let i=0;i<paths.length;i++) if (!has(fields,paths[i])) append(fields,paths[i]);
    }
    for (let i=0;i<fields.length;i++) {
      const field=fields[i];
      if (has(old,field)) {
        await client.query(`UPDATE collection_index_declarations SET filterable=$4,sortable=$5
          WHERE space_id=$1 AND collection_id=$2 AND field_name=$3`,
        [scope.spaceId,definition.slug,field,has(definition.filterable,field),has(definition.sortable,field)]);
        continue;
      }
      const node=definition.schema.properties![field];
      const type=Array.isArray(node.type) ? (node.type[0]==='null' ? node.type[1] : node.type[0]) : node.type;
      const kind=Object.hasOwn(node,'format') && node.format==='date-time' ? 'date-time' : type==='integer' ? 'number' : type;
      await client.query(`INSERT INTO collection_index_declarations
        (space_id,collection_id,field_name,value_kind,filterable,sortable,ready,accepted_version)
        VALUES($1,$2,$3,$4,$5,$6,FALSE,$7)`,
      [scope.spaceId,definition.slug,field,kind,has(definition.filterable,field),has(definition.sortable,field),definition.version]);
    }
  }
  async define(scope:AuthorityScope,input:unknown):Promise<CollectionDefinition> {
    const snapshot=snapshotDefinition(input);
    return this.defineUsing(scope,()=>validateDefinition(snapshot(),true));
  }
  async defineSerialized(scope:AuthorityScope,serialized:string):Promise<CollectionDefinition> {
    return this.defineUsing(scope,()=>validateDefinition(this.parseDefinition(serialized),true));
  }
  private parseDefinition(serialized:string):unknown {
    if (typeof serialized!=='string' || Buffer.byteLength(serialized)>1_048_576) throw new AuthorityError('SCHEMA_UNSUPPORTED');
    try { return JSON.parse(serialized); } catch { throw new AuthorityError('SCHEMA_UNSUPPORTED'); }
  }
  private async defineUsing(scope:AuthorityScope,load:()=>CollectionDefinition):Promise<CollectionDefinition> {
    scope=Object.freeze({...scope});
    return this.transaction(async client=>{
      await this.authorize(client,scope,scope.collectionId,true);
      const definition=load();
      if (definition.version!==1 || definition.slug!==scope.collectionId) throw new AuthorityError('SCHEMA_UNSUPPORTED');
      const exists=await client.query('SELECT 1 FROM collections WHERE space_id=$1 AND collection_id=$2',[scope.spaceId,definition.slug]);
      if (exists.rowCount) throw new AuthorityError('SCHEMA_CONFLICT','Collection already exists');
      try { await client.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)',[scope.spaceId,definition.slug]); }
      catch (error) {
        if ((error as {code?:string}).code==='23505') throw new AuthorityError('SCHEMA_CONFLICT','Collection already exists');
        throw error;
      }
      await client.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
        VALUES($1,$2,1,$3)`,[scope.spaceId,definition.slug,canonical(definition as unknown as Json)]);
      await this.insertDeclarations(client,scope,definition);
      return definition;
    });
  }
  async revise(scope:AuthorityScope,expectedVersion:number,input:unknown):Promise<CollectionDefinition> {
    const snapshot=snapshotDefinition(input);
    return this.reviseUsing(scope,expectedVersion,()=>validateDefinition(snapshot(),true));
  }
  async reviseSerialized(scope:AuthorityScope,expectedVersion:number,serialized:string):Promise<CollectionDefinition> {
    return this.reviseUsing(scope,expectedVersion,()=>validateDefinition(this.parseDefinition(serialized),true));
  }
  private async reviseUsing(scope:AuthorityScope,expectedVersion:number,load:()=>CollectionDefinition):Promise<CollectionDefinition> {
    scope=Object.freeze({...scope});
    if (!validVersion(expectedVersion)) throw new AuthorityError('INVALID_ARGUMENT');
    return this.transaction(async client=>{
      await this.authorize(client,scope,scope.collectionId);
      const next=load();
      if (next.slug!==scope.collectionId) throw new AuthorityError('SCHEMA_UNSUPPORTED');
      const row=(await client.query(`SELECT c.schema_version,v.canonical_definition FROM collections c
        JOIN collection_versions v ON v.space_id=c.space_id AND v.collection_id=c.collection_id AND v.version=c.schema_version
        WHERE c.space_id=$1 AND c.collection_id=$2 FOR UPDATE OF c`,[scope.spaceId,next.slug])).rows[0];
      if (!row) throw new AuthorityError('NOT_FOUND');
      if (Number(row.schema_version)!==expectedVersion) throw new AuthorityError('SCHEMA_CONFLICT',`Current collection version: ${row.schema_version}`);
      const previous=validateDefinition(JSON.parse(row.canonical_definition),true);
      compatible(previous,next);
      await client.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
        VALUES($1,$2,$3,$4)`,[scope.spaceId,next.slug,next.version,canonical(next as unknown as Json)]);
      await this.insertDeclarations(client,scope,next,previous);
      await client.query(`UPDATE collections SET schema_version=$3 WHERE space_id=$1 AND collection_id=$2`,[scope.spaceId,next.slug,next.version]);
      await this.authorize(client,scope,scope.collectionId);
      return next;
    });
  }
  /** A result includes only indexes proven ready; clients must not infer readiness from declaration. */
  async discover(scope:AuthorityScope):Promise<Array<{definition:CollectionDefinition;ready:string[];pending:string[]}>> {
    scope=Object.freeze({...scope});
    return this.transaction(async client=>{
      const row=await client.query(`SELECT s.owner_principal_id,s.lifecycle,s.policy_version,s.placement_generation
        FROM spaces s WHERE s.space_id=$1 FOR SHARE OF s`,[scope.spaceId]);
      const space=row.rows[0];
      if (!space) throw new AuthorityError('NOT_FOUND');
      if (Number(space.policy_version)!==scope.policyVersion || Number(space.placement_generation)!==scope.placementGeneration) throw new AuthorityError('FORBIDDEN');
      if (space.lifecycle!=='active' && space.lifecycle!=='readOnly') throw new AuthorityError('SPACE_UNAVAILABLE');
      const result=await client.query(`SELECT c.collection_id,v.canonical_definition,i.field_name,i.ready,
        g.capabilities,(g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AS grant_current
        FROM collections c JOIN collection_versions v ON v.space_id=c.space_id AND v.collection_id=c.collection_id AND v.version=c.schema_version
        LEFT JOIN collection_index_declarations i ON i.space_id=c.space_id AND i.collection_id=c.collection_id
        LEFT JOIN collection_grants g ON g.space_id=c.space_id AND g.collection_id=c.collection_id AND g.credential_id=$2
        WHERE c.space_id=$1 AND c.lifecycle<>'deleted' ORDER BY c.collection_id,i.field_name`,[scope.spaceId,scope.credentialId]);
      const collections:Array<{definition:CollectionDefinition;ready:string[];pending:string[]}>=[];
      let lastId:string|undefined;
      let entry:typeof collections[number]|undefined;
      for (let i=0;i<result.rows.length;i++) {
        const item=result.rows[i];
        if (space.owner_principal_id!==scope.principalId && (!item.grant_current || !has(item.capabilities??[],scope.capability))) continue;
        if (lastId!==item.collection_id) {
          entry={definition:JSON.parse(item.canonical_definition),ready:[],pending:[]};
          append(collections,entry);
          lastId=item.collection_id;
        }
        if (item.field_name) append(item.ready ? entry!.ready : entry!.pending,item.field_name);
      }
      return collections;
    });
  }
  /** One committed batch; repeat until ready. Cursor and values commit together. */
  async backfill(scope:AuthorityScope,field:string):Promise<{processed:number;ready:boolean}> {
    scope=Object.freeze({...scope});
    if (!scalarString(field) || !field) throw new AuthorityError('INVALID_ARGUMENT');
    return this.transaction(async client=>{
      await this.authorize(client,scope,scope.collectionId);
      // Serialize backfill workers without taking the index row ahead of record
      // locks. A writer takes record locks before FK key-share locks on indexes.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
        [scope.spaceId,JSON.stringify([scope.collectionId,field])]);
      const declaration=(await client.query(`SELECT i.ready,i.backfill_after,v.canonical_definition FROM collection_index_declarations i
        JOIN collections c ON c.space_id=i.space_id AND c.collection_id=i.collection_id
        JOIN collection_versions v ON v.space_id=c.space_id AND v.collection_id=c.collection_id AND v.version=c.schema_version
        WHERE i.space_id=$1 AND i.collection_id=$2 AND i.field_name=$3 FOR SHARE OF c`,[scope.spaceId,scope.collectionId,field])).rows[0];
      if (!declaration) throw new AuthorityError('SCHEMA_UNSUPPORTED','Index is not declared');
      if (declaration.ready) return {processed:0,ready:true};
      const definition=JSON.parse(declaration.canonical_definition) as CollectionDefinition;
      const rows=await client.query(`SELECT record_id,canonical_data FROM records WHERE space_id=$1 AND collection_id=$2
        AND NOT tombstone AND record_id>$3 ORDER BY record_id LIMIT 100 FOR UPDATE`,[scope.spaceId,scope.collectionId,declaration.backfill_after??'']);
      for (let i=0;i<rows.rows.length;i++) {
        const row=rows.rows[i];
        const data=JSON.parse(row.canonical_data) as Record<string,Json>;
        const indexes=derivedValues(data,definition).indexes;
        let index=undefined as typeof indexes[number] | undefined;
        for (let j=0;j<indexes.length;j++) if (indexes[j].field===field) { index=indexes[j]; break; }
        if (!index) continue;
        const value='value' in index ? index.value : null;
        await client.query(`INSERT INTO record_index_values
          (space_id,collection_id,record_id,field_name,value_kind,string_value,number_value,boolean_value,time_value)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (space_id,collection_id,record_id,field_name) DO NOTHING`,
          [scope.spaceId,scope.collectionId,row.record_id,field,index.kind,index.kind==='string'?value:null,
            index.kind==='number'?value:null,index.kind==='boolean'?value:null,index.kind==='date-time'?value:null]);
      }
      if (rows.rows.length) await client.query(`UPDATE collection_index_declarations SET backfill_after=$4
        WHERE space_id=$1 AND collection_id=$2 AND field_name=$3`,[scope.spaceId,scope.collectionId,field,rows.rows[rows.rows.length-1].record_id]);
      if (rows.rows.length<100) await client.query(`UPDATE collection_index_declarations SET ready=TRUE
        WHERE space_id=$1 AND collection_id=$2 AND field_name=$3`,[scope.spaceId,scope.collectionId,field]);
      await this.authorize(client,scope,scope.collectionId);
      return {processed:rows.rows.length,ready:rows.rows.length<100};
    });
  }
}
