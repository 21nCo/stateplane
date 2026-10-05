import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { parseRevision } from '@stateplane/contracts';
import type { Capability, CollectionId, RecordRef, Revision, SpaceId } from '@stateplane/contracts';
import { acceptsInProcessObjects, canonical, derivedParsedValues, externalKey, fingerprint, isInProcessProxy, MAX_INDEX_PART_BYTES, MAX_INDEX_VALUE_BYTES, plainJson, scalarString as unicodeString, utcInstant, validateParsedValue } from './schema.js';
import type { CollectionDefinition, Json } from './schema.js';
export { CollectionRegistry } from './collections.js';
export { externalKey, validateDefinition, validateValue, compatible, derivedValues } from './schema.js';
export type { CollectionDefinition } from './schema.js';

export type RecordMutation = 'create' | 'replace' | 'patch' | 'delete';
export type IndexValue =
  | { field: string; kind: 'null' }
  | { field: string; kind: 'string' | 'date-time'; value: string }
  | { field: string; kind: 'number'; value: number }
  | { field: string; kind: 'boolean'; value: boolean };
export interface UniqueValue { name: string; encodedValue: string }
export interface AuthorityScope {
  spaceId: SpaceId; collectionId: CollectionId; principalId: string; credentialId: string;
  /** outbox:worker is internal and is never grantable or routable. */
  capability: Capability | 'outbox:worker'; policyVersion: number; placementGeneration: number;
}
export interface RecordChange {
  operation: RecordMutation; idempotencyKey: string;
  /** SHA-256 of the validated canonical request, excluding the current schema version. */
  requestDigest: string;
  recordId?: string; expectedRevision?: Revision; expectedSchemaVersion?: number;
  /** Canonical UTF-8 JSON object; omitted on delete. */
  canonicalData?: string; normalizedExternalKey?: string;
  /** Complete derived sets are required for replace and patch, including empty arrays. */
  unique?: readonly UniqueValue[]; indexes?: readonly IndexValue[];
}
export interface Receipt {
  contractVersion: '1'; receiptId: string; spaceId: SpaceId;
  ref: { kind: 'record'; id: string }; operation: RecordMutation;
  beforeRevision: number | null; revision: number; schemaVersion: number;
  committedAt: string; expiresAt: string;
  projection: { generation: number; state: 'pending' }; replayed: boolean;
}
export interface AuthorityRecord {
  ref: RecordRef; revision: number; schemaVersion: number; canonicalData: string;
  keyMode: 'generated' | 'external'; normalizedKey: string; tombstone: boolean;
}
export interface OutboxDelivery {
  eventId: string; ref: RecordRef; revision: number; generation: number; attempt: number;
}
export type ScalarPredicate =
  | { field: string; kind: 'null'; operator: 'isNull' }
  | { field: string; kind: 'string' | 'date-time' | 'number' | 'boolean'; operator: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'; value: string | number | boolean };
export interface RecordSort { field: string; direction: 'asc' | 'desc' }
export interface RecordPage { records: AuthorityRecord[]; nextCursor: string | null; schemaVersion: number }
export interface BatchItemStatus { ordinal:number; state:'pending'|'failed'|'succeeded'; attempts:number; receipt:Receipt|null; failureCode:string|null }
export interface BatchProgress { operationKey:string; state:'active'|'cancelled'; items:BatchItemStatus[] }
interface PageCursor {
  space: string; collection: string; principal: string; credential: string;
  policy: number; placement: number; schema: number; query: string;
  id: string; value: string | number | boolean | null;
}

/** Compile one typed comparison after checking its scalar parameter. */
function comparison(predicate: Exclude<ScalarPredicate, { kind: 'null' }>, alias: string, params: unknown[]): string {
  const column = { string:'string_value','date-time':'time_value',number:'number_value',boolean:'boolean_value' }[predicate.kind];
  const operator = { eq:'=',lt:'<',lte:'<=',gt:'>',gte:'>=' }[predicate.operator];
  if (!operator) throw new AuthorityError('INVALID_ARGUMENT');
  if ((predicate.kind === 'number' && (typeof predicate.value !== 'number' || !isFiniteNumber(predicate.value)))
    || (predicate.kind === 'boolean' && typeof predicate.value !== 'boolean')
    || (predicate.kind === 'string' && (!valueString(predicate.value) || Buffer.byteLength(predicate.value)>MAX_INDEX_VALUE_BYTES))
    || (predicate.kind === 'date-time' && (!scalarString(predicate.value) || Buffer.byteLength(predicate.value)>MAX_INDEX_VALUE_BYTES))) throw new AuthorityError('INVALID_ARGUMENT');
  if (predicate.kind==='date-time') {
    try { utcInstant(predicate.value as string); } catch { throw new AuthorityError('INVALID_ARGUMENT'); }
  }
  params.push(predicate.value);
  if (predicate.kind === 'date-time') {
    return ` AND stateplane_instant_sort_key(${alias}.${column}) COLLATE "C" ${operator} stateplane_instant_sort_key($${params.length}::text) COLLATE "C"`;
  }
  return ` AND ${alias}.${column} ${operator} $${params.length}`;
}

export class AuthorityError extends Error {
  /** Carry a safe current revision for caller-visible conflicts. */
  constructor(public readonly code: string, message = code, public readonly currentRevision?: number) { super(message); this.name = 'AuthorityError'; }
}
class BatchItemFailure extends AuthorityError {}
export class CommitOutcomeUnknownError extends Error {
  /** Require an idempotent retry when COMMIT acknowledgement is ambiguous. */
  constructor(cause: unknown) { super('Commit outcome unknown; retry with the same idempotency key', { cause }); }
}

const MAX_JSON_BYTES = 1_048_576;
const MAX_SCOPE_ID_BYTES = 512;
const MAX_PAGE = 100;
const MAX_PAGE_BYTES = 2_097_152;
const QUERY_TIMEOUT_MS = 5_000;
const retryCodes = new Set(['40P01', '40001']);
const validDigest = /^[0-9a-f]{64}$/;
const serializedMarker=Symbol('stateplane parsed JSON');
const isFiniteNumber = Number.isFinite;
const isSafeInteger = Number.isSafeInteger;
const nativeStringIncludes = String.prototype.includes;
const nativeSetHas=Set.prototype.has;
const nativeSetAdd=Set.prototype.add;
const nativeSetClear=Set.prototype.clear;
const nativeSetForEach=Set.prototype.forEach;
const nativeMapGet=Map.prototype.get;
const nativeMapSet=Map.prototype.set;
const nativeMapHas=Map.prototype.has;
const nativeMapClear=Map.prototype.clear;
const nativeMapForEach=Map.prototype.forEach;
/** Compare own array slots without invoking a replaced includes method. */
const arrayHas=(values:readonly unknown[],wanted:unknown):boolean=>{
  for (let i=0;i<values.length;i++) if (Object.getOwnPropertyDescriptor(values,i)?.value===wanted) return true;
  return false;
};
const append=<T>(values:T[],value:T):void=>{ Object.defineProperty(values,values.length,{value,writable:true,configurable:true,enumerable:true}); };
const setHas=<T>(values:Set<T>,wanted:T):boolean=>Reflect.apply(nativeSetHas,values,[wanted]) as boolean;
const setAdd=<T>(values:Set<T>,wanted:T):void=>{ Reflect.apply(nativeSetAdd,values,[wanted]); };
const setClear=<T>(values:Set<T>):void=>{ Reflect.apply(nativeSetClear,values,[]); };
const mapGet=<T>(values:Map<string,T>,key:string):T|undefined=>Reflect.apply(nativeMapGet,values,[key]) as T|undefined;
const mapSet=<T>(values:Map<string,T>,key:string,value:T):void=>{ Reflect.apply(nativeMapSet,values,[key,value]); };
const mapHas=<T>(values:Map<string,T>,key:string):boolean=>Reflect.apply(nativeMapHas,values,[key]) as boolean;
const mapClear=<T>(values:Map<string,T>):void=>{ Reflect.apply(nativeMapClear,values,[]); };
const mapValues=<T>(source:Map<string,T>):T[]=>{
  const values:T[]=[];
  Reflect.apply(nativeMapForEach,source,[(value:T)=>append(values,value)]);
  return values;
};
const setValues=<T>(source:Set<T>):T[]=>{
  const values:T[]=[];
  Reflect.apply(nativeSetForEach,source,[(value:T)=>append(values,value)]);
  return values;
};
/** Find a JSON string containing U+0000 before choosing the jsonb projection. */
function containsNul(value: Json): boolean {
  if (typeof value==='string') return Reflect.apply(nativeStringIncludes,value,['\0']) as boolean;
  if (value===null || typeof value!=='object') return false;
  const keys=Object.keys(value);
  for (let i=0;i<keys.length;i++) if (containsNul((value as Record<string,Json>)[keys[i]])) return true; // NOSONAR -- own-slot scan avoids replaced array iterators
  return false;
}
/** PostgreSQL jsonb cannot represent U+0000. The canonical text remains the authority. */
function jsonbProjection(canonicalData:string):string|null {
  return Reflect.apply(nativeStringIncludes,canonicalData,[String.raw`\u0000`]) && containsNul(JSON.parse(canonicalData) as Json) ? null : canonicalData;
}
const validScope=(scope:AuthorityScope):boolean =>
  scalarString(scope.spaceId) && Buffer.byteLength(scope.spaceId)<=MAX_SCOPE_ID_BYTES &&
  scalarString(scope.collectionId) && Buffer.byteLength(scope.collectionId)<=MAX_INDEX_PART_BYTES &&
  scalarString(scope.principalId) && Buffer.byteLength(scope.principalId)<=MAX_SCOPE_ID_BYTES &&
  scalarString(scope.credentialId) && Buffer.byteLength(scope.credentialId)<=MAX_SCOPE_ID_BYTES &&
  isSafeInteger(scope.policyVersion) && scope.policyVersion>0 &&
  isSafeInteger(scope.placementGeneration) && scope.placementGeneration>0;
/** Detach nested receipt fields before exposing them to callers. */
function copyReceipt(receipt: Receipt, replayed = receipt.replayed): Receipt {
  return { ...receipt, ref: { ...receipt.ref }, projection: { ...receipt.projection }, replayed };
}
/** Delay receipt timestamps until the surrounding transaction commits. */
function pendingReceiptWithExposure(receipt: Receipt, exposure: ReceiptExposure, replayed = receipt.replayed): Receipt {
  const result = copyReceipt(receipt, replayed);
  for (const field of ['committedAt', 'expiresAt'] as const) {
    Object.defineProperty(result, field, { enumerable: true,
      /** Refuse to expose receipt timestamps until COMMIT succeeds. */
      get() {
        if (!exposure.committedAt) throw new AuthorityError('RECEIPT_PENDING', 'Receipt has not committed');
        return exposure[field];
      } });
  }
  return result;
}
/** Reject malformed Unicode before key and predicate admission. */
function validUnicode(value: string): boolean {
  return unicodeString(value);
}
/** Require a nonempty well-formed string for scoped identifiers. */
function scalarString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && validUnicode(value);
}
/** Allow empty but well-formed indexed string values. */
function valueString(value: unknown): value is string {
  return typeof value === 'string' && validUnicode(value);
}

/** Admit serialized JSON only. Never stringify caller-owned objects or proxies. */
export function canonicalJsonObject(serialized: string): string {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) throw new AuthorityError('SCHEMA_INVALID');
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new AuthorityError('SCHEMA_INVALID'); }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new AuthorityError('SCHEMA_INVALID');
  plainJson(parsed,'SCHEMA_INVALID',0,new Set<object>(),true);
  const result = canonical(parsed as Json);
  if (result !== serialized || Buffer.byteLength(result, 'utf8') > MAX_JSON_BYTES) throw new AuthorityError('SCHEMA_INVALID', 'JSON must be canonical and within the byte limit');
  return result;
}

type PoolLike = Pick<pg.Pool, 'connect'>;
type Client = pg.PoolClient;
type ReceiptExposure = { committedAt: string; expiresAt: string };
type PendingReceipt = { response: Receipt; exposure: ReceiptExposure; retentionSeconds: number;
  digest: string; collectionId: CollectionId; key: string };
type ReadyReceipt = { receiptId: string; exposure: ReceiptExposure; committedAt: string; expiresAt: string };
export interface JoinedReceiptState {
  pending: Map<string, PendingReceipt>;
  replayed: Map<string, { collectionId: CollectionId; digest: string; response: Receipt }>;
  ready: ReadyReceipt[];
}
const scopeIds = (scope: AuthorityScope) => [scope.spaceId, scope.collectionId];

/** Check low-level operation shape before a transaction can write records. */
function validateChangeShape(change: RecordChange): void {
  if (!arrayHas(['create','replace','patch','delete'],change.operation) || !scalarString(change.idempotencyKey) || Buffer.byteLength(change.idempotencyKey)>MAX_INDEX_PART_BYTES
    || typeof change.requestDigest !== 'string' || !validDigest.test(change.requestDigest)) throw new AuthorityError('INVALID_ARGUMENT');
  if (change.operation === 'create') {
    if (change.recordId !== undefined || change.expectedRevision !== undefined) throw new AuthorityError('INVALID_ARGUMENT');
  } else if (!scalarString(change.recordId) || change.expectedRevision === undefined) throw new AuthorityError('INVALID_ARGUMENT');
  if (change.normalizedExternalKey !== undefined && (change.operation !== 'create' || !scalarString(change.normalizedExternalKey) || Buffer.byteLength(change.normalizedExternalKey)>MAX_INDEX_PART_BYTES)) throw new AuthorityError('INVALID_ARGUMENT');
  if (change.expectedRevision !== undefined) parseRevision(change.expectedRevision);
  if (change.expectedSchemaVersion !== undefined && (!isSafeInteger(change.expectedSchemaVersion) || change.expectedSchemaVersion < 1)) throw new AuthorityError('INVALID_ARGUMENT');
  if (change.operation === 'delete' && (change.canonicalData !== undefined || change.unique?.length || change.indexes?.length)) throw new AuthorityError('INVALID_ARGUMENT');
  if ((change.operation === 'replace' || change.operation === 'patch') && (!change.unique || !change.indexes)) throw new AuthorityError('INVALID_ARGUMENT');
}

/** Copy and bound low-level unique reservations before the first await. */
function snapshotUnique(source: readonly UniqueValue[] | undefined): readonly UniqueValue[] | undefined {
  if (source === undefined) return undefined;
  if (!Array.isArray(source)) throw new AuthorityError('INVALID_ARGUMENT');
  const seen = new Set<string>();
  const values: UniqueValue[] = [];
  for (let i = 0; i < source.length; i++) {
    const entry = source[i];
    if (!entry || !scalarString(entry.name) || !scalarString(entry.encodedValue) || Buffer.byteLength(entry.name)>MAX_INDEX_PART_BYTES || Buffer.byteLength(entry.encodedValue)>MAX_INDEX_VALUE_BYTES) throw new AuthorityError('INVALID_ARGUMENT');
    const key = JSON.stringify([entry.name, entry.encodedValue]);
    if (setHas(seen,key)) throw new AuthorityError('INVALID_ARGUMENT');
    setAdd(seen,key);
    append(values,Object.freeze({ name: entry.name, encodedValue: entry.encodedValue }));
  }
  return Object.freeze(values);
}

/** Copy typed index values before any caller-owned object can change. */
function snapshotIndexes(source: readonly IndexValue[] | undefined): readonly IndexValue[] | undefined {
  if (source === undefined) return undefined;
  if (!Array.isArray(source)) throw new AuthorityError('INVALID_ARGUMENT');
  const seen = new Set<string>();
  const values: IndexValue[] = [];
  for (let i = 0; i < source.length; i++) {
    const entry = source[i];
    if (!entry || !scalarString(entry.field) || Buffer.byteLength(entry.field)>MAX_INDEX_PART_BYTES || setHas(seen,entry.field)) throw new AuthorityError('INVALID_ARGUMENT');
    setAdd(seen,entry.field);
    validateIndexValue(entry);
    append(values,Object.freeze({ ...entry }));
  }
  return Object.freeze(values);
}
/** Enforce the bounded scalar representation for each stored index kind. */
function validateIndexValue(entry:IndexValue):void {
  const value = 'value' in entry ? entry.value : null;
  if ((entry.kind === 'number' && (typeof value !== 'number' || !isFiniteNumber(value)))
    || (entry.kind === 'string' && (!valueString(value) || Buffer.byteLength(value)>MAX_INDEX_VALUE_BYTES))
    || (entry.kind === 'date-time' && (!scalarString(value) || Buffer.byteLength(value)>MAX_INDEX_VALUE_BYTES))
    || (entry.kind === 'boolean' && typeof value !== 'boolean')
    || (entry.kind === 'null' && value !== null && value !== undefined)
    || !arrayHas(['null','string','date-time','number','boolean'],entry.kind)) throw new AuthorityError('INVALID_ARGUMENT');
}

/** Detach caller-owned fields before any await, including the first retry attempt. */
function snapshotChange(source: RecordChange): Readonly<RecordChange> {
  if (!source || typeof source !== 'object') throw new AuthorityError('INVALID_ARGUMENT');
  const change: RecordChange = {
    operation: source.operation, idempotencyKey: source.idempotencyKey, requestDigest: source.requestDigest,
    recordId: source.recordId, expectedRevision: source.expectedRevision,
    expectedSchemaVersion: source.expectedSchemaVersion, canonicalData: source.canonicalData,
    // The low-level path shares the public key normalizer; old rows are handled at lookup.
    normalizedExternalKey: source.normalizedExternalKey === undefined ? undefined : externalKey(source.normalizedExternalKey),
    unique: snapshotUnique(source.unique), indexes: snapshotIndexes(source.indexes)
  };
  validateChangeShape(change);
  return Object.freeze(change);
}

/** Detach a payload member while deferring invalid JSON until after authorization. */
function snapshotPayload(value:unknown,key:string,trustedParsed:boolean):unknown {
  try {
    plainJson(value,'SCHEMA_INVALID',0,new Set<object>(),trustedParsed);
    return JSON.parse(canonical(value as Json));
  } catch {
    // Keep an invalid object-shaped patch as invalid JSON so payload
    // validation, after authorization and replay lookup, reports
    // SCHEMA_INVALID. Preserve a non-object set for shape validation.
    return key==='set' && value !== null && typeof value==='object' && !Array.isArray(value)
      ? Object.defineProperty(Object.create(null),'invalid',{value:undefined,enumerable:true})
      : undefined;
  }
}
/** Copy an own data member without retaining caller-owned objects or accessors. */
function snapshotEnvelopeMember(input:object,fixed:Record<string,unknown>,key:PropertyKey,trustedParsed:boolean):boolean {
  const descriptor=Object.getOwnPropertyDescriptor(input,key);
  if (typeof key!=='string' || !descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) return false;
  const value=descriptor.value;
  let detached:unknown=value;
  if (key==='data' || key==='set' || key==='unset') detached=snapshotPayload(value,key,trustedParsed);
  else if (value !== null && typeof value==='object') detached=undefined;
  Object.defineProperty(fixed,key,{value:detached,enumerable:true});
  return true;
}
/** Detach the requested envelope before a transaction can await authorization. */
function snapshotRequest(input: unknown, trustedParsed = false): unknown {
  if (input === null || typeof input !== 'object') return input;
  if (!trustedParsed && (!acceptsInProcessObjects || isInProcessProxy(input))) throw new AuthorityError('INVALID_ARGUMENT');
  const fixed:Record<string,unknown>=Object.create(null);
  // Retain malformed shape as data so the requested collection is authorized first.
  // Never retain the caller's prototype or invoke an accessor while taking the snapshot.
  let malformed=Array.isArray(input) || (Object.getPrototypeOf(input)!==Object.prototype && Object.getPrototypeOf(input)!==null);
  const keys=Reflect.ownKeys(input);
  for (let i=0;i<keys.length;i++) {
    const key=Object.getOwnPropertyDescriptor(keys,i)!.value as PropertyKey;
    if (!snapshotEnvelopeMember(input,fixed,key,trustedParsed)) malformed=true;
  }
  if (malformed) Object.defineProperty(fixed,Symbol('malformed envelope'),{value:true,enumerable:true});
  return fixed;
}

/** Validate the detached operation envelope before deriving any record facts. */
function requestOperation(fields:Record<string,unknown>):RecordMutation {
  const operation=fields.operation;
  if (!arrayHas(['create','replace','patch','delete'],operation) || !unicodeString(fields.idempotencyKey) ||
    !fields.idempotencyKey || Buffer.byteLength(fields.idempotencyKey)>MAX_INDEX_PART_BYTES)
    throw new AuthorityError('INVALID_ARGUMENT');
  const has=(key:string)=>Object.hasOwn(fields,key);
  let invalidShape:boolean;
  if (operation==='create') invalidShape=has('id') || has('expectedRevision') || has('set') || has('unset') || !has('data');
  else {
    invalidShape=!unicodeString(fields.id) || !fields.id || !isSafeInteger(fields.expectedRevision) ||
      (fields.expectedRevision as number)<1 || has('externalKey');
    if (operation==='replace') invalidShape ||= !has('data') || has('set') || has('unset');
    else if (operation==='patch') invalidShape ||= !has('set') || !has('unset') || has('data');
    else invalidShape ||= has('data') || has('set') || has('unset');
  }
  if (invalidShape || has('expectedSchemaVersion') &&
    (!isSafeInteger(fields.expectedSchemaVersion) || (fields.expectedSchemaVersion as number)<1))
    throw new AuthorityError('INVALID_ARGUMENT');
  return operation as RecordMutation;
}

/** Canonicalize an authorized payload and bind its digest to the requested scope. */
function prepareRecordPayload(fields:Record<string,unknown>,operation:RecordMutation,fixed:Readonly<RecordChange>,
  normalized:string|undefined,scope:AuthorityScope,trustedParsed:boolean):Readonly<RecordChange> {
  prepareCanonicalFields(fields,operation,trustedParsed);
  const payload=requestFingerprintFields(fields,normalized,scope);
  let canonicalData: string|undefined;
  if (operation==='create' || operation==='replace') canonicalData=canonical(fields.data as Json);
  else if (operation==='patch') canonicalData=canonical(fields.set as Json);
  return snapshotChange({...fixed,requestDigest:fingerprint(payload),
    ...(canonicalData===undefined ? {} : {canonicalData})});
}
/** Canonicalize payload members after authorization and replay admission. */
function prepareCanonicalFields(fields:Record<string,unknown>,operation:RecordMutation,trustedParsed:boolean):void {
  if (operation==='create' || operation==='replace') {
    plainJson(fields.data,'SCHEMA_INVALID',0,new Set<object>(),trustedParsed);
    fields.data=JSON.parse(canonical(fields.data as Json));
  }
  if (operation==='patch') {
    if (!fields.set || typeof fields.set!=='object' || Array.isArray(fields.set) || !Array.isArray(fields.unset)) throw new AuthorityError('INVALID_ARGUMENT');
    plainJson(fields.set,'SCHEMA_INVALID',0,new Set<object>(),trustedParsed);
    plainJson(fields.unset,'INVALID_ARGUMENT',0,new Set<object>(),trustedParsed);
    validateUnsetPaths(fields.unset as unknown[],fields.set as object);
    fields.set=JSON.parse(canonical(fields.set as Json));
    fields.unset=JSON.parse(canonical(fields.unset as Json));
  }
}
/** Reject repeated, nonstring, or set-and-unset patch paths. */
function validateUnsetPaths(unset:unknown[],set:object):void {
  for (let i=0;i<unset.length;i++) {
    const path=Object.getOwnPropertyDescriptor(unset,i)!.value;
    if (!unicodeString(path) || !path || Object.hasOwn(set,path)) throw new AuthorityError('INVALID_ARGUMENT');
    for (let j=0;j<i;j++) if (Object.getOwnPropertyDescriptor(unset,j)!.value===path) throw new AuthorityError('INVALID_ARGUMENT');
  }
}
/** Bind the canonical request digest to collection and credential scope. */
function requestFingerprintFields(fields:Record<string,unknown>,normalized:string|undefined,scope:AuthorityScope):Record<string,Json> {
  const payload: Record<string,Json>=Object.create(null);
  const fingerprintFields=['operation','id','externalKey','data','set','unset','expectedRevision','expectedSchemaVersion'];
  for (let i=0;i<fingerprintFields.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const key=fingerprintFields[i];
    if (Object.hasOwn(fields,key)) payload[key]=key==='externalKey' ? normalized! : fields[key] as Json;
  }
  payload.collection=scope.collectionId;
  payload.credential=scope.credentialId;
  return payload;
}

/** Reject decorated predicates and retain stable own values for query admission. */
function snapshotPredicates(source: readonly ScalarPredicate[], trustedParsed=false): readonly ScalarPredicate[] {
  if ((!trustedParsed && !acceptsInProcessObjects) || (!trustedParsed && isInProcessProxy(source)) || !Array.isArray(source) ||
    Object.getPrototypeOf(source)!==Array.prototype || source.length > 16 || Reflect.ownKeys(source).length!==source.length+1)
    throw new AuthorityError('INVALID_ARGUMENT');
  const result: ScalarPredicate[]=[];
  for (let i=0;i<source.length;i++) {
    const item=Object.getOwnPropertyDescriptor(source,i)?.value;
    append(result,snapshotPredicate(item,trustedParsed));
  }
  return Object.freeze(result);
}
function parseSerializedPredicates(serialized:string):readonly ScalarPredicate[] {
  if (typeof serialized!=='string' || Buffer.byteLength(serialized)>32_768) throw new AuthorityError('INVALID_ARGUMENT');
  try { return snapshotPredicates(JSON.parse(serialized),true); }
  catch { throw new AuthorityError('INVALID_ARGUMENT'); }
}
/** Retain a predicate's own data properties and reject decorated objects. */
function snapshotPredicate(item:unknown,trustedParsed=false):ScalarPredicate {
  if (!item || typeof item!=='object' || (!trustedParsed && isInProcessProxy(item)) ||
    (Object.getPrototypeOf(item)!==Object.prototype && Object.getPrototypeOf(item)!==null)) throw new AuthorityError('INVALID_ARGUMENT');
  const field=Object.getOwnPropertyDescriptor(item,'field')?.value;
  const kind=Object.getOwnPropertyDescriptor(item,'kind')?.value;
  const operator=Object.getOwnPropertyDescriptor(item,'operator')?.value;
  const value=Object.getOwnPropertyDescriptor(item,'value')?.value;
  const accepted=kind==='null' ? ['field','kind','operator'] : ['field','kind','operator','value'];
  const keys=Reflect.ownKeys(item);
  if (keys.length!==accepted.length) throw new AuthorityError('INVALID_ARGUMENT');
  for (let j=0;j<keys.length;j++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const key=keys[j],descriptor=Object.getOwnPropertyDescriptor(item,key);
    if (typeof key!=='string' || !arrayHas(accepted,key) || !descriptor?.enumerable || !Object.hasOwn(descriptor,'value'))
      throw new AuthorityError('INVALID_ARGUMENT');
  }
  if (kind==='null') return Object.freeze({field,kind,operator}) as ScalarPredicate;
  return Object.freeze({field,kind,operator,value}) as ScalarPredicate;
}
/** Match a declared index using only trusted own result-array slots. */
function findDeclaration(rows:readonly Record<string,unknown>[],field:string):Record<string,unknown>|undefined {
  for (let i=0;i<rows.length;i++) {
    const row=Object.getOwnPropertyDescriptor(rows,i)?.value as Record<string,unknown>|undefined;
    if (row?.field_name===field) return row;
  }
  return undefined;
}
function snapshotSort(input: RecordSort | undefined,trustedParsed=false): RecordSort | undefined {
  if (input===undefined) return undefined;
  if (!input || typeof input!=='object' || (!trustedParsed && isInProcessProxy(input)) ||
    (Object.getPrototypeOf(input)!==Object.prototype && Object.getPrototypeOf(input)!==null) ||
    Reflect.ownKeys(input).length!==2 || !Object.hasOwn(input,'field') || !Object.hasOwn(input,'direction'))
    throw new AuthorityError('INVALID_ARGUMENT');
  const field=Object.getOwnPropertyDescriptor(input,'field')?.value;
  const direction=Object.getOwnPropertyDescriptor(input,'direction')?.value;
  if (!scalarString(field) || !field || Buffer.byteLength(field)>MAX_INDEX_PART_BYTES ||
    !arrayHas(['asc','desc'],direction)) throw new AuthorityError('INVALID_ARGUMENT');
  return Object.freeze({field,direction});
}
function digestQuery(predicates:readonly ScalarPredicate[], sort:RecordSort|undefined, limit:number):string {
  return createHash('sha256').update(JSON.stringify({predicates,sort:sort??null,limit})).digest('hex');
}
function signCursor(cursor:PageCursor, secret:Uint8Array):string {
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(secret).digest(),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(cursor),'utf8'),cipher.final()]);
  return Buffer.concat([iv,encrypted,cipher.getAuthTag()]).toString('base64url');
}
function decodeCursor(token:string, secret:Uint8Array):PageCursor {
  if (typeof token!=='string' || token.length>4096 || !/^[A-Za-z0-9_-]+$/.test(token))
    throw new AuthorityError('INVALID_CURSOR');
  try {
    const bytes=Buffer.from(token,'base64url');
    if (bytes.length<29) throw new Error('size');
    const decipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(secret).digest(),bytes.subarray(0,12));
    decipher.setAuthTag(bytes.subarray(bytes.length-16));
    const plain=Buffer.concat([decipher.update(bytes.subarray(12,bytes.length-16)),decipher.final()]);
    const cursor=JSON.parse(plain.toString('utf8')) as PageCursor;
    if (!cursor || typeof cursor!=='object' || typeof cursor.id!=='string' || !cursor.id ||
      typeof cursor.query!=='string' || !/^[0-9a-f]{64}$/.test(cursor.query) ||
      !(cursor.value===null || ['string','number','boolean'].includes(typeof cursor.value))) throw new Error('shape');
    return cursor;
  } catch { throw new AuthorityError('INVALID_CURSOR'); }
}

export class PostgresAuthority {
  /** Configure the receipt window used by new authority transactions. */
  constructor(private readonly pool: PoolLike, private readonly receiptRetentionSeconds: number,
    private readonly cursorSecret?: Uint8Array) {
    if (!isSafeInteger(receiptRetentionSeconds) || receiptRetentionSeconds < 1) throw new RangeError('Invalid receipt retention');
    if (cursorSecret && cursorSecret.byteLength < 32) throw new RangeError('Cursor secret must contain at least 32 bytes');
    if (cursorSecret) this.cursorSecret=Buffer.from(cursorSecret);
  }

  /** Callback side effects are never retried. A COMMIT failure is deliberately ambiguous. */
  async transaction<T>(scope: AuthorityScope, fn: (tx: AuthorityTransaction) => Promise<T>): Promise<T> {
    // Capture the authenticated identity before waiting for a pooled connection.
    const fixedScope = Object.freeze({ ...scope });
    if (!validScope(fixedScope)) throw new AuthorityError('INVALID_ARGUMENT');
    const client = await this.pool.connect();
    let begun = false;
    let beginAttempted = false;
    let discard = false;
    let tx: AuthorityTransaction | undefined;
    try {
      beginAttempted = true;
      await client.query('BEGIN'); begun = true;
      tx = new AuthorityTransaction(client, fixedScope, this.receiptRetentionSeconds, undefined, this.cursorSecret);
      await tx.checkScope();
      const result = await fn(tx);
      tx.sealMutations();
      await tx.settleMutations();
      tx.assertCommittable();
      await tx.checkScope();
      await tx.checkReplayScopes();
      await tx.finalizeReceipts();
      await tx.checkScope();
      await tx.checkReplayScopes();
      await tx.ensureReceiptsCurrent();
      try { await client.query('COMMIT'); begun = false; }
      catch (error) { discard = true; throw new CommitOutcomeUnknownError(error); }
      tx.exposeReceipts();
      return result;
    } catch (error) {
      if (tx) { tx.sealMutations(); await tx.settleMutations(); }
      if (begun) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
      else if (beginAttempted) discard = true;
      if ((error as {code?:string}).code==='57014') throw new AuthorityError('RATE_LIMITED','Database statement time limit exceeded');
      if ((error as {code?:string}).code==='55P03') throw new AuthorityError('BACKPRESSURE','Database lock budget exceeded');
      throw error;
    } finally { tx?.close(); client.release(discard); }
  }

  /** Join an already authorized cell transaction; the caller owns COMMIT/ROLLBACK. */
  async transactionOnClient<T>(client: Client, scope: AuthorityScope, fn: (tx: AuthorityTransaction) => Promise<T>,
    deferUntilCommit: (finish: () => Promise<void>, verify: () => Promise<void>, ensureCurrent: () => Promise<number>, expose: () => void,
      close: () => void) => void,
    joinedReceipts?: JoinedReceiptState): Promise<T> {
    const fixedScope = Object.freeze({ ...scope });
    if (!validScope(fixedScope)) throw new AuthorityError('INVALID_ARGUMENT');
    const tx = new AuthorityTransaction(client, fixedScope, this.receiptRetentionSeconds, joinedReceipts, this.cursorSecret);
    let deferred = false;
    try {
      await tx.checkScope();
      const result = await fn(tx);
      tx.sealMutations();
      await tx.settleMutations();
      tx.assertCommittable();
      const finish = async () => {
        tx.assertCommittable();
        await tx.checkScope();
        await tx.checkReplayScopes();
      };
      const verify = async () => {
        tx.assertCommittable();
        await tx.checkScope();
        await tx.checkReplayScopes();
        await tx.finalizeReceipts();
      };
      deferUntilCommit(finish, verify, () => tx.ensureReceiptsCurrent(), () => tx.exposeReceipts(), () => tx.close());
      deferred = true;
      return result;
    } catch (error) {
      tx.sealMutations();
      await tx.settleMutations();
      if ((error as {code?:string}).code==='57014') throw new AuthorityError('RATE_LIMITED','Database statement time limit exceeded');
      if ((error as {code?:string}).code==='55P03') throw new AuthorityError('BACKPRESSURE','Database lock budget exceeded');
      throw error;
    } finally { if (!deferred) tx.close(); }
  }

  /** Retry only server-confirmed deadlock/serialization rollbacks, never failed COMMIT. */
  async mutate(scope: AuthorityScope, change: RecordChange): Promise<Receipt> {
    const fixedScope = Object.freeze({ ...scope });
    const fixedChange = snapshotChange(change);
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.transaction(fixedScope, tx => tx.mutate(fixedChange)); }
      catch (error) {
        if (!setHas(retryCodes,(error as { code?: string }).code ?? '') || attempt === 2) throw error;
      }
    }
    throw new Error('unreachable');
  }

  /** Public record entrypoint: derive validation, reservations and indexes inside authority. */
  async mutateRequest(scope: AuthorityScope, request: unknown): Promise<Receipt> {
    const fixedScope=Object.freeze({...scope});
    const fixedRequest=snapshotRequest(request);
    for (let attempt=0;attempt<3;attempt++) {
      try { return await this.transaction(fixedScope,tx=>tx.mutateRequest(fixedRequest)); } // NOSONAR -- SQL operations must remain serial in this transaction
      catch (error) { if (!setHas(retryCodes,(error as {code?:string}).code ?? '') || attempt===2) throw error; }
    }
    throw new Error('unreachable');
  }

  /** Cloudflare-safe boundary: parse primitive JSON bytes after scope authorization. */
  async mutateSerializedRequest(scope:AuthorityScope,serialized:string):Promise<Receipt> {
    const fixedScope=Object.freeze({...scope});
    for (let attempt=0;attempt<3;attempt++) {
      try { return await this.transaction(fixedScope,tx=>tx.mutateSerializedRequest(serialized)); } // NOSONAR -- SQL operations must remain serial in this transaction
      catch (error) { if (!setHas(retryCodes,(error as {code?:string}).code ?? '') || attempt===2) throw error; }
    }
    throw new Error('unreachable');
  }

  /** A bounded manifest is durable before individual item transactions begin. */
  async ingestBatch(scope:AuthorityScope,operationKey:string,requests:readonly string[],retryFailed=false):Promise<BatchProgress> {
    if (!acceptsInProcessObjects || isInProcessProxy(requests)) throw new AuthorityError('INVALID_ARGUMENT');
    return this.ingestBatchUsing(scope,operationKey,requests,retryFailed);
  }

  /** Cloudflare-safe batch boundary: parse manifest bytes only after scope authorization. */
  async ingestSerializedBatch(scope:AuthorityScope,operationKey:string,serialized:string,retryFailed=false):Promise<BatchProgress> {
    const requests=await this.transaction(scope,async tx=>{
      if (tx.scope.capability!=='records:write') throw new AuthorityError('FORBIDDEN');
      if (typeof serialized!=='string' || Buffer.byteLength(serialized)>3_145_728) throw new AuthorityError('RATE_LIMITED');
      try { return JSON.parse(serialized) as string[]; } catch { throw new AuthorityError('INVALID_ARGUMENT'); }
    });
    return this.ingestBatchUsing(scope,operationKey,requests,retryFailed);
  }

  private async ingestBatchUsing(scope:AuthorityScope,operationKey:string,requests:readonly string[],retryFailed:boolean):Promise<BatchProgress> {
    if (!Array.isArray(requests) || Object.getPrototypeOf(requests)!==Array.prototype ||
      requests.length<1 || requests.length>20 || Reflect.ownKeys(requests).length!==requests.length+1 ||
      typeof operationKey!=='string' || !unicodeString(operationKey) || !operationKey ||
      Buffer.byteLength(operationKey)>MAX_INDEX_PART_BYTES || typeof retryFailed!=='boolean')
      throw new AuthorityError('INVALID_ARGUMENT');
    const fixed:string[]=[];
    let total=0;
    for (let i=0;i<requests.length;i++) {
      const item=Object.getOwnPropertyDescriptor(requests,i)?.value;
      if (!unicodeString(item)) throw new AuthorityError('INVALID_ARGUMENT');
      total+=Buffer.byteLength(item);
      if (total>MAX_PAGE_BYTES || Buffer.byteLength(item)>MAX_JSON_BYTES) throw new AuthorityError('RATE_LIMITED','Batch byte budget exceeded');
      append(fixed,item);
    }
    const digest=createHash('sha256').update(JSON.stringify(fixed)).digest('hex');
    await this.transaction(scope,tx=>tx.startBatch(operationKey,digest,fixed));
    const deadline=Date.now()+30_000;
    for (let ordinal=0;ordinal<fixed.length;ordinal++) {
      if (Date.now()>=deadline) break;
      try { await this.transaction(scope,tx=>tx.processBatchItem(operationKey,ordinal,retryFailed)); }
      catch (error) {
        if (error instanceof AuthorityError && error.code==='BATCH_CANCELLED') break;
        if (error instanceof BatchItemFailure) {
          try { await this.transaction(scope,tx=>tx.failBatchItem(operationKey,ordinal,error.code)); }
          catch (failure) { if (failure instanceof AuthorityError && failure.code==='BATCH_CANCELLED') break; throw failure; }
          continue;
        }
        throw error;
      }
    }
    return this.batchProgress(scope,operationKey);
  }

  batchProgress(scope:AuthorityScope,operationKey:string):Promise<BatchProgress> {
    return this.transaction(scope,tx=>tx.batchProgress(operationKey));
  }

  cancelBatch(scope:AuthorityScope,operationKey:string):Promise<BatchProgress> {
    return this.transaction(scope,async tx=>{ await tx.cancelBatch(operationKey); return tx.batchProgress(operationKey); });
  }
}

export class AuthorityTransaction {
  private active = true;
  private mutationFailed = false;
  private mutationError: unknown;
  private readonly pendingReceipts: JoinedReceiptState['pending'];
  private readonly joinedReplays: JoinedReceiptState['replayed'];
  private readonly readyReceipts: JoinedReceiptState['ready'];
  private activeOperationTail: Promise<void> = Promise.resolve();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly reservedIdentities = new Map<string, { operation: RecordMutation; key: string }>();
  private admittingMutations = true;
  private readonly replayCollections = new Set<CollectionId>();
  private readonly batchReceiptIds = new Set<string>();
  readonly #scope: Readonly<AuthorityScope>;
  /** Expose the frozen scope used by every operation in this transaction. */
  get scope(): Readonly<AuthorityScope> { return this.#scope; }
  /** Join an authorized client and optionally share pending receipt state. */
  constructor(private readonly client: Client, scope: AuthorityScope, private readonly retentionSeconds: number,
    joinedReceipts?: JoinedReceiptState, private readonly cursorSecret?: Uint8Array) {
    this.#scope = Object.freeze({ ...scope });
    this.pendingReceipts = joinedReceipts?.pending ?? new Map();
    this.joinedReplays = joinedReceipts?.replayed ?? new Map();
    this.readyReceipts = joinedReceipts?.ready ?? [];
  }
  /** Prevent new work and release transaction-local replay state. */
  close() { this.active = false; this.admittingMutations = false; mapClear(this.reservedIdentities); setClear(this.replayCollections); }
  /** A caught mutation error must not turn a partial write into a successful commit. */
  assertCommittable() {
    if (this.mutationFailed) throw this.mutationError;
  }
  /** Stop admission before final policy, receipt, and COMMIT checks. */
  sealMutations() { this.admittingMutations = false; }
  /** Drain admitted operations before the final authorization and commit. */
  async settleMutations() { await this.activeOperationTail; await this.mutationTail; }
  /** Keep the transaction open until an admitted operation settles. */
  private trackOperation(work:Promise<unknown>):void {
    const settled=work.then(()=>{},()=>{});
    this.activeOperationTail=this.activeOperationTail.then(()=>settled);
  }
  /** Track admitted operations so callback return cannot bypass their completion. */
  private admitOperation<T>(work: () => Promise<T>, rollbackOnError = false): Promise<T> {
    if (!this.admittingMutations || !this.active) return Promise.reject(new AuthorityError('INVALID_ARGUMENT', 'Transaction admission ended'));
    const running = Promise.resolve().then(() => { this.assertCommittable(); return work(); })
      .catch(error => { if (rollbackOnError) { this.mutationFailed = true; this.mutationError = error; } throw error; });
    this.trackOperation(running);
    return running;
  }
  /** Deny SQL after transaction-local authority state has closed. */
  private query(sql: string, values: unknown[] = []) {
    if (!this.active) throw new AuthorityError('INVALID_ARGUMENT', 'Transaction ended');
    return this.client.query(sql, values);
  }

  private batchKey(operationKey:string,allowRead=false):unknown[] {
    if (this.#scope.capability!=='records:write' && !(allowRead && this.#scope.capability==='records:read'))
      throw new AuthorityError('FORBIDDEN');
    if (!unicodeString(operationKey) || !operationKey || Buffer.byteLength(operationKey)>MAX_INDEX_PART_BYTES)
      throw new AuthorityError('INVALID_ARGUMENT');
    return [...scopeIds(this.#scope),this.#scope.credentialId,operationKey];
  }

  startBatch(operationKey:string,digest:string,requests:readonly string[]):Promise<void> {
    return this.admitOperation(async()=>{
      const key=this.batchKey(operationKey);
      await this.query("SET LOCAL lock_timeout = '100ms'");
      await this.query("SET LOCAL statement_timeout = '15000ms'");
      try {
        await this.query(`INSERT INTO batch_operations(space_id,collection_id,credential_id,operation_key,manifest_digest,item_count)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[...key,digest,requests.length]);
        const row=(await this.query(`SELECT manifest_digest,item_count,state FROM batch_operations
          WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3 AND operation_key=$4 FOR UPDATE`,key)).rows[0];
        if (!row || row.manifest_digest!==digest || Number(row.item_count)!==requests.length)
          throw new AuthorityError('BATCH_CONFLICT','Operation key has a different manifest');
        if (row.state==='cancelled') throw new AuthorityError('BATCH_CANCELLED');
        for (let ordinal=0;ordinal<requests.length;ordinal++)
          await this.query(`INSERT INTO batch_items(space_id,collection_id,credential_id,operation_key,ordinal,request_text)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[...key,ordinal,requests[ordinal]]);
      } catch(error) { if ((error as {code?:string}).code==='55P03') throw new AuthorityError('BACKPRESSURE'); throw error; }
    },true);
  }

  processBatchItem(operationKey:string,ordinal:number,retryFailed:boolean):Promise<void> {
    return this.admitOperation(async()=>{
      const key=this.batchKey(operationKey);
      await this.query("SET LOCAL lock_timeout = '100ms'");
      await this.query("SET LOCAL statement_timeout = '15000ms'");
      try {
        const batch=(await this.query(`SELECT state FROM batch_operations WHERE space_id=$1 AND collection_id=$2
          AND credential_id=$3 AND operation_key=$4 FOR UPDATE`,key)).rows[0];
        if (!batch) throw new AuthorityError('NOT_FOUND');
        if (batch.state==='cancelled') throw new AuthorityError('BATCH_CANCELLED');
        const item=(await this.query(`SELECT state,request_text FROM batch_items WHERE space_id=$1 AND collection_id=$2
          AND credential_id=$3 AND operation_key=$4 AND ordinal=$5 FOR UPDATE`,[...key,ordinal])).rows[0];
        if (!item) throw new AuthorityError('NOT_FOUND');
        if (item.state==='succeeded' || (item.state==='failed' && !retryFailed)) return;
        let request:Record<string,unknown>;
        try {
          const parsed=JSON.parse(item.request_text);
          if (!parsed || typeof parsed!=='object' || Array.isArray(parsed) || Object.hasOwn(parsed,'idempotencyKey'))
            throw new Error('invalid batch item');
          request=parsed;
        } catch { throw new BatchItemFailure('INVALID_ARGUMENT','Malformed batch item'); }
        const itemKey=`b_${createHash('sha256').update(JSON.stringify(key)).update(`:${ordinal}`).digest('hex')}`;
        let receipt:Receipt;
        try { receipt=await this.mutateSerializedRequest(JSON.stringify({...request,idempotencyKey:itemKey})); }
        catch (error) {
          if (error instanceof AuthorityError && arrayHas(['INVALID_ARGUMENT','SCHEMA_INVALID','SCHEMA_CONFLICT',
            'REVISION_CONFLICT','UNIQUE_CONFLICT','KEY_RESERVED','NOT_FOUND'],error.code))
            throw new BatchItemFailure(error.code);
          throw error;
        }
        await this.query(`UPDATE batch_items SET state='succeeded',failure_code=NULL,receipt_id=$6,
          receipt=COALESCE(receipt,$7::jsonb),attempts=attempts+1
          WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3 AND operation_key=$4 AND ordinal=$5`,
        [...key,ordinal,receipt.receiptId,receipt.replayed ? JSON.stringify(receipt) : null]);
        if (!receipt.replayed) setAdd(this.batchReceiptIds,receipt.receiptId);
      } catch(error) { if ((error as {code?:string}).code==='55P03') throw new AuthorityError('BACKPRESSURE'); throw error; }
    },true);
  }

  failBatchItem(operationKey:string,ordinal:number,code:string):Promise<void> {
    return this.admitOperation(async()=>{
      const key=this.batchKey(operationKey);
      const result=await this.query(`UPDATE batch_items SET state='failed',failure_code=$6,attempts=attempts+1
        WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3 AND operation_key=$4 AND ordinal=$5
          AND state<>'succeeded' AND EXISTS (SELECT 1 FROM batch_operations b
            WHERE b.space_id=$1 AND b.collection_id=$2 AND b.credential_id=$3 AND b.operation_key=$4 AND b.state='active')`,
      [...key,ordinal,code]);
      if (!result.rowCount) throw new AuthorityError('BATCH_CANCELLED');
    },true);
  }

  cancelBatch(operationKey:string):Promise<void> {
    return this.admitOperation(async()=>{
      const key=this.batchKey(operationKey);
      const result=await this.query(`UPDATE batch_operations SET state='cancelled'
        WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3 AND operation_key=$4`,key);
      if (!result.rowCount) throw new AuthorityError('NOT_FOUND');
    },true);
  }

  batchProgress(operationKey:string):Promise<BatchProgress> {
    return this.admitOperation(async()=>{
      const key=this.batchKey(operationKey,true);
      const rows=await this.query(`SELECT b.state AS batch_state,i.ordinal,i.state,i.attempts,i.failure_code,i.receipt
        FROM batch_operations b JOIN batch_items i USING(space_id,collection_id,credential_id,operation_key)
        WHERE b.space_id=$1 AND b.collection_id=$2 AND b.credential_id=$3 AND b.operation_key=$4 ORDER BY i.ordinal`,key);
      if (!rows.rows.length) throw new AuthorityError('NOT_FOUND');
      return {operationKey,state:rows.rows[0].batch_state,items:rows.rows.map(row=>({ordinal:row.ordinal,state:row.state,
        attempts:row.attempts,failureCode:row.failure_code,receipt:row.receipt}))};
    });
  }

  /** Hold shared policy/placement/collection locks through commit. Application policy remains explicit. */
  async checkScope(): Promise<void> {
    const { spaceId, collectionId, principalId, credentialId, capability, policyVersion, placementGeneration } = this.#scope;
    const result = await this.query(`SELECT s.owner_principal_id, s.lifecycle, s.policy_version, s.placement_generation,
      c.lifecycle AS collection_lifecycle, g.capabilities, g.expires_at, g.grant_current
      FROM spaces s JOIN collections c ON c.space_id=s.space_id
      LEFT JOIN LATERAL (
        SELECT capabilities,expires_at,expires_at > clock_timestamp() AS grant_current FROM collection_grants
        WHERE space_id=c.space_id AND collection_id=c.collection_id AND credential_id=$3
          AND s.owner_principal_id<>$4 FOR SHARE
      ) g ON TRUE
      WHERE s.space_id=$1 AND c.collection_id=$2 FOR SHARE OF s,c`, [spaceId, collectionId, credentialId, principalId]);
    const row = result.rows[0];
    if (!row) throw new AuthorityError('NOT_FOUND');
    if (Number(row.policy_version) !== policyVersion || Number(row.placement_generation) !== placementGeneration) throw new AuthorityError('FORBIDDEN', 'Policy or placement changed');
    if (arrayHas(['suspended','deleting','deleted'],row.lifecycle)) throw new AuthorityError('SPACE_UNAVAILABLE');
    if (row.collection_lifecycle === 'deleted') throw new AuthorityError('NOT_FOUND');
    if (capability === 'outbox:worker' && (principalId !== 'system:projection' || credentialId !== 'system:projection'))
      throw new AuthorityError('FORBIDDEN');
    // Archiving stops new writes, but committed projection jobs still need to drain.
    if (capability === 'outbox:worker' && row.lifecycle !== 'active' && row.lifecycle !== 'readOnly')
      throw new AuthorityError('SPACE_UNAVAILABLE');
    if (row.owner_principal_id !== principalId && capability !== 'outbox:worker' &&
      (!Array.isArray(row.capabilities) || !arrayHas(row.capabilities,capability) || (row.expires_at && !row.grant_current))) throw new AuthorityError('FORBIDDEN');
    if (row.collection_lifecycle === 'readOnly' && (capability === 'records:write' || capability === 'claims:review')) throw new AuthorityError('SPACE_UNAVAILABLE');
  }

  /** Scope a stored record ID to this transaction's collection. */
  private ref(id: string): RecordRef { return { spaceId: this.#scope.spaceId, collectionId: this.#scope.collectionId, id }; }
  /** Read a record through the admitted operation queue. */
  getRecord(recordId: string, includeTombstone = false): Promise<AuthorityRecord | null> {
    return this.admitOperation(() => this.readRecord(recordId,includeTombstone));
  }
  /** Apply read authorization and tombstone visibility to a record lookup. */
  private async readRecord(recordId: string, includeTombstone = false): Promise<AuthorityRecord | null> {
    if (this.#scope.capability !== 'records:read') throw new AuthorityError('FORBIDDEN');
    if (!scalarString(recordId)) throw new AuthorityError('INVALID_ARGUMENT');
    const result = await this.query(`SELECT record_id,revision,schema_version,canonical_data,key_mode,normalized_key,tombstone FROM records
      WHERE space_id=$1 AND collection_id=$2 AND record_id=$3 ${includeTombstone ? '' : 'AND NOT tombstone'}`, [...scopeIds(this.#scope), recordId]);
    const row = result.rows[0];
    return row ? { ref: this.ref(row.record_id), revision: Number(row.revision), schemaVersion: Number(row.schema_version),
      canonicalData: row.canonical_data, keyMode: row.key_mode, normalizedKey: row.normalized_key, tombstone: row.tombstone } : null;
  }
  /** Resolve a live key by its v1 identity, including historical raw spellings. */
  getByKey(mode: 'generated' | 'external', key: string): Promise<AuthorityRecord | null> {
    return this.admitOperation(async () => {
    if (this.#scope.capability !== 'records:read') throw new AuthorityError('FORBIDDEN');
    if (!arrayHas(['generated','external'],mode) || !scalarString(key)) throw new AuthorityError('INVALID_ARGUMENT');
    const normalized=mode==='external' ? externalKey(key) : key;
    const identity=mode==='external' ? 'public.stateplane_external_key_identity(normalized_key)' : 'normalized_key';
    const result = await this.query(`SELECT record_id FROM records WHERE space_id=$1 AND collection_id=$2
      AND key_mode=$3 AND ${identity}=$4 AND NOT tombstone LIMIT 2`,
      [...scopeIds(this.#scope), mode, normalized]);
    if (result.rows.length>1) throw new AuthorityError('SCHEMA_CONFLICT','External key has multiple historical records; use a record ID');
    return result.rows[0] ? this.readRecord(result.rows[0].record_id) : null;
    });
  }
  /** Look up a committed receipt before admitting a new mutation effect. */
  private async findReceipt(operation: RecordMutation, key: string): Promise<{ collectionId: CollectionId; requestDigest: string; response: Receipt } | null> {
    const result = await this.query(`SELECT collection_id,request_digest,response FROM idempotency_receipts
      WHERE space_id=$1 AND credential_id=$2 AND operation=$3 AND idempotency_key=$4 AND expires_at>clock_timestamp()`,
    [this.#scope.spaceId, this.#scope.credentialId, operation, key]);
    const row = result.rows[0];
    return row ? { collectionId: row.collection_id, requestDigest: row.request_digest, response: row.response } : null;
  }
  /** Compute receipt windows from one database-clock statement. */
  private async receiptTimes(retentions: number[]): Promise<Array<{ committedAt: string; expiresAt: string }>> {
    const clock = await this.query(`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT at AS committed_at, at + (retention * interval '1 second') AS expires_at
      FROM stamp CROSS JOIN unnest($1::bigint[]) WITH ORDINALITY AS policy(retention, position)
      ORDER BY position`, [retentions]);
    if (clock.rows.length !== retentions.length) throw new Error('Receipt clock row count mismatch');
    const times:Array<{committedAt:string;expiresAt:string}>=[];
    for (let i=0;i<clock.rows.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
      const row=clock.rows[i];
      append(times,{committedAt:(row.committed_at as Date).toISOString(),expiresAt:(row.expires_at as Date).toISOString()});
    }
    return times;
  }
  /** Stamp receipts using the database clock after callback work, immediately before COMMIT. */
  async finalizeReceipts(): Promise<void> {
    const pendingReceipts = mapValues(this.pendingReceipts);
    if (pendingReceipts.length) {
      const retentions:number[]=[];
      for (let i=0;i<pendingReceipts.length;i++) append(retentions,pendingReceipts[i].retentionSeconds); // NOSONAR -- own-slot scan avoids replaced array iterators
      const times = await this.receiptTimes(retentions);
      for (let index=0;index<pendingReceipts.length;index++) {
        const pending=pendingReceipts[index];
        const { committedAt, expiresAt } = times[index];
        pending.response.committedAt = committedAt;
        pending.response.expiresAt = expiresAt;
        await this.query(`INSERT INTO idempotency_receipts(receipt_id,space_id,collection_id,credential_id,operation,idempotency_key,request_digest,record_id,response,committed_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`, [pending.response.receiptId,this.#scope.spaceId,pending.collectionId,
          this.#scope.credentialId,pending.response.operation,pending.key,pending.digest,pending.response.ref.id,
          JSON.stringify(pending.response),committedAt,expiresAt]);
        if (setHas(this.batchReceiptIds,pending.response.receiptId))
          await this.query(`UPDATE batch_items SET receipt=$2::jsonb WHERE receipt_id=$1`,
            [pending.response.receiptId,JSON.stringify(pending.response)]);
        append(this.readyReceipts,{receiptId:pending.response.receiptId,exposure:pending.exposure,committedAt,expiresAt});
      }
      mapClear(this.pendingReceipts);
    }
    const reserved=mapValues(this.reservedIdentities);
    for (let i=0;i<reserved.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
      const { operation, key }=reserved[i];
      await this.query(`WITH identity AS (DELETE FROM receipt_reservations
          WHERE space_id=$1 AND credential_id=$3 AND operation=$4 AND idempotency_key=$5 RETURNING 1)
        DELETE FROM receipt_reservation_scopes WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3
          AND operation=$4 AND idempotency_key=$5 AND EXISTS(SELECT 1 FROM identity)`,
        [this.#scope.spaceId,this.#scope.collectionId,this.#scope.credentialId,operation,key]);
    }
    mapClear(this.reservedIdentities);
  }
  /** A slow final cell check must abort rather than commit an already expired
   * receipt and let an immediate retry create a second record. */
  async ensureReceiptsCurrent(): Promise<number> {
    const ids:string[]=[];
    const seen=new Set<string>();
    const addId=(id:string)=>{ if (!setHas(seen,id)) { setAdd(seen,id); append(ids,id); } };
    for (let i=0;i<this.readyReceipts.length;i++) addId(this.readyReceipts[i].receiptId); // NOSONAR -- own-slot scan avoids replaced array iterators
    const replays=mapValues(this.joinedReplays);
    for (let i=0;i<replays.length;i++) addId(replays[i].response.receiptId); // NOSONAR -- own-slot scan avoids replaced array iterators
    if (!ids.length) return Infinity;
    const result=await this.query(`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT count(r.receipt_id)::int AS found,
        count(r.receipt_id) FILTER (WHERE r.expires_at<=stamp.at)::int AS expired,
        EXTRACT(EPOCH FROM (min(r.expires_at)-stamp.at)) * 1000 AS remaining_ms
      FROM stamp LEFT JOIN idempotency_receipts r ON r.receipt_id=ANY($1::text[])
      GROUP BY stamp.at`,[ids]);
    if (result.rows[0]?.found !== ids.length || result.rows[0]?.expired !== 0)
      throw new AuthorityError('RECEIPT_EXPIRED','Receipt expired before commit');
    const remainingMs = Number(result.rows[0]?.remaining_ms);
    if (!isFiniteNumber(remainingMs) || remainingMs <= 0)
      throw new AuthorityError('RECEIPT_EXPIRED','Receipt expired before commit');
    return remainingMs;
  }
  /** Publish committed receipt timestamps after successful COMMIT only. */
  exposeReceipts(): void {
    for (let i=0;i<this.readyReceipts.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
      const ready=this.readyReceipts[i];
      ready.exposure.committedAt = ready.committedAt;
      ready.exposure.expiresAt = ready.expiresAt;
    }
    this.readyReceipts.length = 0;
  }
  /** Recheck the original collection before returning a cross-collection replay. */
  private async authorizeOriginal(collectionId: CollectionId): Promise<void> {
    if (collectionId === this.#scope.collectionId) return;
    await new AuthorityTransaction(this.client, { ...this.#scope, collectionId }, this.retentionSeconds).checkScope();
    setAdd(this.replayCollections,collectionId);
  }

  /** Recheck every replayed collection before the transaction commits. */
  async checkReplayScopes(): Promise<void> {
    const collections=setValues(this.replayCollections);
    for (let i=0;i<collections.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
      const collectionId=collections[i];
      await new AuthorityTransaction(this.client, { ...this.#scope, collectionId }, this.retentionSeconds).checkScope();
    }
  }

  /** Queue one low-level change and poison the transaction on failure. */
  async mutate(change: RecordChange): Promise<Receipt> {
    try {
      if (!this.admittingMutations || !this.active) throw new AuthorityError('INVALID_ARGUMENT', 'Transaction mutation admission ended');
      this.assertCommittable();
      const fixed = snapshotChange(change);
      const tail = this.mutationTail;
      const work = (async () => { await tail; this.assertCommittable(); return this.mutateOnce(fixed); })()
        .catch(error => { this.mutationFailed = true; this.mutationError = error; throw error; });
      this.mutationTail = work.then(() => {}, () => {});
      this.trackOperation(work);
      return await work;
    }
    catch (error) {
      this.mutationFailed = true;
      this.mutationError = error;
      throw error;
    }
  }

  /** Validate the user envelope after scope authorization, before receipt disclosure. */
  async mutateRequest(input: unknown, trustedMarker?: symbol): Promise<Receipt> {
    const trustedParsed=trustedMarker===serializedMarker;
    try {
      if (!this.admittingMutations || !this.active) throw new AuthorityError('INVALID_ARGUMENT','Transaction mutation admission ended');
      const fixedInput=snapshotRequest(input,trustedParsed);
      this.assertCommittable();
      return await this.mutateRequestOnce(fixedInput,true);
    }
    catch (error) { this.mutationFailed=true; this.mutationError=error; throw error; }
  }

  /** Use inside a joined regional cell transaction to retain its credential fence. */
  async mutateSerializedRequest(serialized:string):Promise<Receipt> {
    try {
      if (!this.admittingMutations || !this.active) throw new AuthorityError('INVALID_ARGUMENT','Transaction mutation admission ended');
      this.assertCommittable();
      if (typeof serialized!=='string' || Buffer.byteLength(serialized)>MAX_JSON_BYTES) throw new AuthorityError('INVALID_ARGUMENT');
      let input:unknown;
      try { input=JSON.parse(serialized); } catch { throw new AuthorityError('INVALID_ARGUMENT'); }
      return await this.mutateRequest(input,serializedMarker);
    } catch (error) { this.mutationFailed=true; this.mutationError=error; throw error; }
  }

  /** Validate one envelope and derive its canonical effect inside the collection lock. */
  private async mutateRequestOnce(input: unknown, trustedParsed:boolean): Promise<Receipt> {
    if (this.#scope.capability !== 'records:write') throw new AuthorityError('FORBIDDEN');
    if ((!trustedParsed && !acceptsInProcessObjects) || !input || typeof input!=='object' ||
      (!trustedParsed && acceptsInProcessObjects && isInProcessProxy(input)) || Array.isArray(input) ||
      (Object.getPrototypeOf(input)!==Object.prototype && Object.getPrototypeOf(input)!==null)) throw new AuthorityError('INVALID_ARGUMENT');
    const fields: Record<string,unknown>=Object.create(null);
    const accepted=['operation','idempotencyKey','id','externalKey','data','set','unset','expectedRevision','expectedSchemaVersion'];
    const keys=Reflect.ownKeys(input);
    for (let i=0;i<keys.length;i++) {
      const key=Object.getOwnPropertyDescriptor(keys,i)!.value as PropertyKey;
      const descriptor=Object.getOwnPropertyDescriptor(input,key);
      if (typeof key!=='string' || !arrayHas(accepted,key) || !descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) throw new AuthorityError('INVALID_ARGUMENT');
      fields[key]=descriptor.value;
    }
    const operation=requestOperation(fields);
    const has=(key:string)=>Object.hasOwn(fields,key);
    const normalized=has('externalKey') ? externalKey(fields.externalKey) : undefined;
    const preliminary: RecordChange={operation:operation as RecordMutation,idempotencyKey:fields.idempotencyKey as string,requestDigest:'0'.repeat(64),
      ...(has('id') ? {recordId:fields.id as string,expectedRevision:fields.expectedRevision as Revision} : {}),
      ...(has('expectedSchemaVersion') ? {expectedSchemaVersion:fields.expectedSchemaVersion as number} : {}),
      ...(normalized ? {normalizedExternalKey:normalized} : {}),
      ...(operation==='delete' ? {} : {canonicalData:'{}'}),
      ...(operation==='replace' || operation==='patch' ? {unique:[],indexes:[]} : {})};
    const fixed=snapshotChange(preliminary);
    const preparePayload=()=>prepareRecordPayload(fields,operation,fixed,normalized,this.#scope,trustedParsed);
    const tail=this.mutationTail;
    const work=(async()=>{
      await tail;
      this.assertCommittable();
      return this.mutateOnce(fixed,(version,base)=>this.prepareMutation(fields,operation,version,base),preparePayload);
    })().catch(error=>{this.mutationFailed=true;this.mutationError=error;throw error;});
    this.mutationTail=work.then(()=>{},()=>{});
    this.trackOperation(work);
    return await work;
  }

  /** Derive a validated change under the collection version and record locks. */
  private async prepareMutation(fields:Record<string,unknown>,operation:RecordMutation,
    version:{definition:string},base:RecordChange):Promise<RecordChange> {
    const definition=JSON.parse(version.definition) as CollectionDefinition;
    const previous=await this.previousRecord(fields,operation);
    let data:Record<string,Json>|undefined;
    if (operation==='create' || operation==='replace') data=fields.data as Record<string,Json>;
    if (operation==='patch') data=this.patchRecord(previous!,fields,definition);
    if (!data) return base;
    validateParsedValue(data as Json,definition.schema);
    const canonicalData=canonical(data);
    if (Buffer.byteLength(canonicalData,'utf8')>MAX_JSON_BYTES) throw new AuthorityError('SCHEMA_INVALID','Record exceeds canonical byte limit');
    this.checkLifecycle(data,previous,operation,definition);
    return {...base,canonicalData,...derivedParsedValues(data,definition)};
  }

  /** Lock the current record and expose the safe revision on a stale write. */
  private async previousRecord(fields:Record<string,unknown>,operation:RecordMutation):Promise<Record<string,Json>|undefined> {
    if (operation==='create') return undefined;
    const row=(await this.query(`SELECT revision,canonical_data FROM records WHERE space_id=$1 AND collection_id=$2 AND record_id=$3 AND NOT tombstone FOR UPDATE`,
      [...scopeIds(this.#scope),fields.id])).rows[0];
    if (!row) throw new AuthorityError('NOT_FOUND');
    if (Number(row.revision)!==fields.expectedRevision) throw new AuthorityError('REVISION_CONFLICT','Record revision changed',Number(row.revision));
    return JSON.parse(row.canonical_data) as Record<string,Json>;
  }

  /** Apply only declared optional unsets to the prior canonical record. */
  private patchRecord(previous:Record<string,Json>,fields:Record<string,unknown>,definition:CollectionDefinition):Record<string,Json> {
    const data={...previous,...fields.set as Record<string,Json>};
    const unset=fields.unset as string[];
    for (let i=0;i<unset.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
      const path=unset[i];
      if (!Object.hasOwn(definition.schema,'properties') || !Object.hasOwn(definition.schema.properties!,path) ||
        arrayHas(Object.hasOwn(definition.schema,'required') ? definition.schema.required! : [],path))
        throw new AuthorityError('INVALID_ARGUMENT','Unset requires a declared optional field');
      delete data[path];
    }
    return data;
  }

  /** Check declared lifecycle transitions after the record has been validated. */
  private checkLifecycle(data:Record<string,Json>,previous:Record<string,Json>|undefined,
    operation:RecordMutation,definition:CollectionDefinition):void {
    if (!Object.hasOwn(definition,'lifecycle') || !definition.lifecycle) return;
    const {field,transitions}=definition.lifecycle;
    const to=Object.hasOwn(data,field) ? data[field] : undefined;
    const from=previous && Object.hasOwn(previous,field) ? previous[field] : undefined;
    const changed=from!==to;
    const transition=typeof from==='string' && Object.hasOwn(transitions,from) ? transitions[from] : undefined;
    const invalid=operation==='create' ? !arrayHas(definition.lifecycle.initial,to) :
      changed && (!transition || !arrayHas(transition,to));
    if (invalid)
      throw new AuthorityError('SCHEMA_INVALID','Lifecycle transition is not declared');
  }

  /** Uncommitted unique rows provide Hyperdrive-compatible, scoped try-locks. */
  private async reserveIdentity(change: Readonly<RecordChange>, identity: string): Promise<void> {
    if (mapHas(this.reservedIdentities,identity)) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.query(`SELECT reservation_state,original_collection_id FROM stateplane_try_reserve_receipt($1,$2,$3,$4,$5,$6)`,
        [this.#scope.spaceId,this.#scope.collectionId,this.#scope.credentialId,this.#scope.principalId,
          change.operation,change.idempotencyKey]);
      const row = result.rows[0];
      if (row?.reservation_state === 'reserved') {
        mapSet(this.reservedIdentities,identity,{operation:change.operation,key:change.idempotencyKey});
        return;
      }
      if (row?.reservation_state === 'pending' && scalarString(row.original_collection_id)) {
        // The owner can finish between the server probe and response delivery.
        // Retry once before disclosing pending state or denying a fresh write.
        if (attempt === 0) continue;
        await this.checkScope();
        await this.authorizeOriginal(row.original_collection_id);
        throw new AuthorityError('RECEIPT_PENDING');
      }
      if (row?.reservation_state === 'unresolved') throw new AuthorityError('FORBIDDEN');
      throw new Error('Invalid receipt reservation result');
    }
  }

  /** Return a still-authorized receipt replay or reserve the fresh identity. */
  private async lookupReplay(change: RecordChange, identity: string,
    preparePayload?: () => Readonly<RecordChange>): Promise<{ replay: Receipt | null; change: RecordChange }> {
    const scope = this.#scope;
    const validated=():RecordChange=>{
      const actual=preparePayload ? preparePayload() : change;
      if (actual.operation !== 'delete') canonicalJsonObject(actual.canonicalData!);
      return actual;
    };
    const pending = mapGet(this.pendingReceipts,identity);
    if (pending) {
      await this.authorizeOriginal(pending.collectionId);
      const actual=validated();
      if (pending.digest !== actual.requestDigest) throw new AuthorityError('IDEMPOTENCY_MISMATCH');
      return {replay:pendingReceiptWithExposure(pending.response, pending.exposure, true),change:actual};
    }
    const joinedReplay = mapGet(this.joinedReplays,identity);
    if (joinedReplay) {
      await this.authorizeOriginal(joinedReplay.collectionId);
      const actual=validated();
      if (joinedReplay.digest !== actual.requestDigest) throw new AuthorityError('IDEMPOTENCY_MISMATCH');
      return {replay:copyReceipt(joinedReplay.response, true),change:actual};
    }
    await this.reserveIdentity(change,identity);
    const previous = await this.findReceipt(change.operation, change.idempotencyKey);
    if (previous) {
      await this.authorizeOriginal(previous.collectionId);
      const actual=validated();
      if (previous.requestDigest !== actual.requestDigest) throw new AuthorityError('IDEMPOTENCY_MISMATCH');
      mapSet(this.joinedReplays,identity,{collectionId:previous.collectionId,digest:previous.requestDigest,response:previous.response});
      return {replay:copyReceipt(previous.response, true),change:actual};
    }
    await this.query(`DELETE FROM idempotency_receipts WHERE space_id=$1 AND credential_id=$2
      AND operation=$3 AND idempotency_key=$4 AND expires_at<=clock_timestamp()`,
    [scope.spaceId,scope.credentialId,change.operation,change.idempotencyKey]);
    if (preparePayload) {
      const lifecycle=(await this.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[scope.spaceId])).rows[0]?.lifecycle;
      if (lifecycle==='readOnly') throw new AuthorityError('SPACE_UNAVAILABLE');
      return {replay:null,change:validated()};
    }
    return {replay:null,change};
  }

  /** Lock the active version until its record effect commits or rolls back. */
  private async currentVersion(change: RecordChange): Promise<{ schemaVersion: number; generation: number; definition: string }> {
    const scope = this.#scope;
    const versions = await this.query(`SELECT s.lifecycle,s.placement_generation,c.lifecycle AS collection_lifecycle,c.schema_version,v.canonical_definition
      FROM spaces s JOIN collections c ON c.space_id=s.space_id
      JOIN collection_versions v ON v.space_id=c.space_id AND v.collection_id=c.collection_id AND v.version=c.schema_version
      WHERE s.space_id=$1 AND c.collection_id=$2 FOR SHARE OF c`, scopeIds(scope));
    const version = versions.rows[0];
    if (version.lifecycle !== 'active' || version.collection_lifecycle !== 'active') throw new AuthorityError('SPACE_UNAVAILABLE');
    if (change.operation !== 'delete') canonicalJsonObject(change.canonicalData!);
    if (change.expectedSchemaVersion !== undefined && change.expectedSchemaVersion !== Number(version.schema_version)) throw new AuthorityError('SCHEMA_CONFLICT');
    return { schemaVersion:Number(version.schema_version), generation:Number(version.placement_generation),definition:version.canonical_definition };
  }

  /** Apply a generated create or exact-revision update under one transaction. */
  private async writeRecord(change: RecordChange, schemaVersion: number): Promise<{ recordId: string; beforeRevision: number | null; revision: number }> {
    if (change.operation === 'create') return this.createRecord(change,schemaVersion);
    return this.updateRecord(change,schemaVersion);
  }

  /** Reserve a historical external alias before creating its first revision. */
  private async createRecord(change:RecordChange,schemaVersion:number):Promise<{recordId:string;beforeRevision:null;revision:1}> {
    const scope = this.#scope;
    const recordId = `rec_${randomUUID()}`;
    const mode = change.normalizedExternalKey === undefined ? 'generated' : 'external';
    if (change.normalizedExternalKey !== undefined) {
      // The ordinary unique constraint also fences concurrent new writes;
      // this indexed probe reserves historical raw and tombstone aliases.
      const held=await this.query(`SELECT 1 FROM records WHERE space_id=$1 AND collection_id=$2
        AND key_mode='external' AND public.stateplane_external_key_identity(normalized_key)=$3 LIMIT 1`,
        [...scopeIds(scope),change.normalizedExternalKey]);
      if (held.rowCount) throw new AuthorityError('KEY_RESERVED');
    }
    await this.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
      VALUES($1,$2,$3,1,$4,$5,$6,$7::text,$8::jsonb)`, [...scopeIds(scope),recordId,schemaVersion,mode,change.normalizedExternalKey ?? recordId,change.canonicalData,jsonbProjection(change.canonicalData!)]);
    return { recordId, beforeRevision:null, revision:1 };
  }

  /** Update one live revision, preserving its key reservation on deletion. */
  private async updateRecord(change:RecordChange,schemaVersion:number):Promise<{recordId:string;beforeRevision:number;revision:number}> {
    const scope = this.#scope;
    const recordId = change.recordId!;
    const updated = await this.query(`UPDATE records SET revision=revision+1,schema_version=$5,
      canonical_data=CASE WHEN $6::boolean THEN canonical_data ELSE $7::text END,
      data=CASE WHEN $6::boolean THEN data ELSE $8::jsonb END,
      tombstone=$6,updated_at=clock_timestamp()
      WHERE space_id=$1 AND collection_id=$2 AND record_id=$3 AND revision=$4 AND NOT tombstone RETURNING revision`,
    [...scopeIds(scope),recordId,change.expectedRevision,schemaVersion,change.operation === 'delete',change.canonicalData ?? null,
      change.operation==='delete' ? null : jsonbProjection(change.canonicalData!)]);
    if (!updated.rowCount) await this.throwCurrentRevision(recordId);
    const revision = Number(updated.rows[0].revision);
    if (change.operation === 'delete') {
      await this.query('INSERT INTO record_tombstones(space_id,collection_id,record_id,revision) VALUES($1,$2,$3,$4)', [...scopeIds(scope),recordId,revision]);
    } else {
      // Historical reservations remain on tombstones. Updates may release only live tuples.
      await this.query('DELETE FROM record_unique_keys WHERE space_id=$1 AND collection_id=$2 AND record_id=$3', [...scopeIds(scope),recordId]);
    }
    await this.query('DELETE FROM record_index_values WHERE space_id=$1 AND collection_id=$2 AND record_id=$3', [...scopeIds(scope),recordId]);
    return { recordId, beforeRevision:change.expectedRevision!, revision };
  }

  /** Report the committed live revision after a failed compare-and-swap. */
  private async throwCurrentRevision(recordId:string):Promise<never> {
    const exists = await this.query('SELECT revision FROM records WHERE space_id=$1 AND collection_id=$2 AND record_id=$3 AND NOT tombstone',
      [...scopeIds(this.#scope),recordId]);
    if (!exists.rowCount) throw new AuthorityError('NOT_FOUND');
    throw new AuthorityError('REVISION_CONFLICT','Record revision changed',Number(exists.rows[0].revision));
  }

  /** Reserve one normalized tuple, distinguishing live and tombstone holders. */
  private async reserveUnique(unique: UniqueValue, recordId: string): Promise<void> {
    const scope = this.#scope;
    const inserted = await this.query(`INSERT INTO record_unique_keys(space_id,collection_id,constraint_name,encoded_value,record_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT (space_id,collection_id,constraint_name,encoded_value) DO NOTHING
      RETURNING record_id`, [...scopeIds(scope),unique.name,unique.encodedValue,recordId]);
    if (inserted.rowCount) return;
    const holder = await this.query(`SELECT r.tombstone FROM record_unique_keys u JOIN records r
      ON r.space_id=u.space_id AND r.collection_id=u.collection_id AND r.record_id=u.record_id
      WHERE u.space_id=$1 AND u.collection_id=$2 AND u.constraint_name=$3 AND u.encoded_value=$4`,
    [...scopeIds(scope),unique.name,unique.encodedValue]);
    throw new AuthorityError(holder.rows[0]?.tombstone ? 'KEY_RESERVED' : 'UNIQUE_CONFLICT');
  }

  /** Persist one typed index value alongside the canonical record. */
  private async writeIndex(field: IndexValue, recordId: string): Promise<void> {
    const value = 'value' in field ? field.value : null;
    await this.query(`INSERT INTO record_index_values(space_id,collection_id,record_id,field_name,value_kind,string_value,number_value,boolean_value,time_value)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [...scopeIds(this.#scope),recordId,field.field,field.kind,
      field.kind === 'string' ? value : null,field.kind === 'number' ? value : null,
      field.kind === 'boolean' ? value : null,field.kind === 'date-time' ? value : null]);
  }

  /** Write all unique reservations and indexes inside the record transaction. */
  private async writeValues(change: RecordChange, recordId: string): Promise<void> {
    if (change.operation === 'delete') return;
    const uniqueValues = change.unique ?? [];
    for (let i = 0; i < uniqueValues.length; i++) await this.reserveUnique(uniqueValues[i], recordId);
    const indexValues = change.indexes ?? [];
    for (let i = 0; i < indexValues.length; i++) await this.writeIndex(indexValues[i], recordId);
  }

  /** Add the event, outbox entry, and pending receipt for a written revision. */
  private async appendFacts(change: RecordChange, identity: string, version: { schemaVersion: number; generation: number },
    written: { recordId: string; beforeRevision: number | null; revision: number }): Promise<Receipt> {
    const scope = this.#scope;
    const { recordId, beforeRevision, revision } = written;
    const eventId = `evt_${randomUUID()}`;
    await this.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,operation,credential_id,schema_version,canonical_data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [eventId,...scopeIds(scope),recordId,revision,change.operation,scope.credentialId,version.schemaVersion,change.canonicalData ?? '{}']);
    const receiptId = `rcpt_${randomUUID()}`;
    const response: Receipt = { contractVersion:'1',receiptId,spaceId:scope.spaceId,ref:{kind:'record',id:recordId},operation:change.operation,
      beforeRevision,revision,schemaVersion:version.schemaVersion,committedAt:'',expiresAt:'',
      projection:{generation:version.generation,state:'pending'},replayed:false };
    await this.query('INSERT INTO projection_outbox(event_id,space_id,collection_id,record_id,revision,generation) VALUES($1,$2,$3,$4,$5,$6)',
      [eventId,...scopeIds(scope),recordId,revision,version.generation]);
    const exposure: ReceiptExposure = { committedAt:'', expiresAt:'' };
    const returned = pendingReceiptWithExposure(response, exposure);
    mapSet(this.pendingReceipts,identity, { response, exposure, retentionSeconds:this.retentionSeconds,
      digest:change.requestDigest, collectionId:scope.collectionId, key:change.idempotencyKey });
    return returned;
  }

  /** Apply one revision-safe record change and its receipt, event and projections. */
  private async mutateOnce(change: RecordChange,
    prepare?: (version: { schemaVersion:number;generation:number;definition:string },base:RecordChange)=>Promise<RecordChange>,
    preparePayload?: () => Readonly<RecordChange>): Promise<Receipt> {
    const scope = this.#scope;
    if (scope.capability !== 'records:write') throw new AuthorityError('FORBIDDEN');
    const identity = JSON.stringify([scope.spaceId,scope.credentialId,change.operation,change.idempotencyKey]);
    const lookup = await this.lookupReplay(change, identity, preparePayload);
    if (lookup.replay) return lookup.replay;
    change=lookup.change;
    await this.query("SET LOCAL statement_timeout = '15000ms'");
    const slot=await this.query(`SELECT slot FROM collection_write_slots
      WHERE space_id=$1 AND collection_id=$2 ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1`,scopeIds(scope));
    if (!slot.rowCount) throw new AuthorityError('BACKPRESSURE','Collection write concurrency limit reached');
    const version = await this.currentVersion(change);
    if (prepare) change=await prepare(version,change);
    try {
      const written = await this.writeRecord(change, version.schemaVersion);
      await this.writeValues(change, written.recordId);
      return await this.appendFacts(change, identity, version, written);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const constraint = (error as { constraint?: string }).constraint;
        throw new AuthorityError(constraint === 'records_space_id_collection_id_key_mode_normalized_key_key' ? 'KEY_RESERVED' : 'UNIQUE_CONFLICT');
      }
      if ((error as { code?: string }).code === '23503') throw new AuthorityError('SCHEMA_CONFLICT');
      throw error;
    }
  }

  /** Shared AND predicate compiler for exact page, count and exists statement snapshots. */
  private compilePredicates(predicates: readonly ScalarPredicate[]) {
    if (this.#scope.capability !== 'records:read') throw new AuthorityError('FORBIDDEN');
    if (!Array.isArray(predicates) || predicates.length > 16) throw new AuthorityError('INVALID_ARGUMENT');
    const params: unknown[] = [...scopeIds(this.#scope)];
    const fragments: string[] = [];
    for (let index = 0; index < predicates.length; index++) {
      const predicate = predicates[index];
      if (!predicate) throw new AuthorityError('INVALID_ARGUMENT');
      if (!scalarString(predicate.field) || !arrayHas(['null','string','date-time','number','boolean'],predicate.kind)) throw new AuthorityError('INVALID_ARGUMENT');
      const alias = `v${index}`;
      params.push(predicate.field,predicate.kind);
      const fieldParam = `$${params.length - 1}`;
      const kindParam = `$${params.length}`;
      let compare = '';
      if (predicate.kind === 'null') {
        if (predicate.operator !== 'isNull') throw new AuthorityError('INVALID_ARGUMENT');
      } else compare = comparison(predicate, alias, params);
      fragments.push(`EXISTS (SELECT 1 FROM record_index_values ${alias} WHERE ${alias}.space_id=r.space_id
        AND ${alias}.collection_id=r.collection_id AND ${alias}.record_id=r.record_id
        AND ${alias}.field_name=${fieldParam} AND ${alias}.value_kind=${kindParam}${compare})`);
    }
    return { params, where:'r.space_id=$1 AND r.collection_id=$2 AND NOT r.tombstone ' + fragments.map(x => `AND ${x}`).join(' ') };
  }

  /** Reject undeclared or partially backfilled filter indexes. */
  private async requireReadyIndexes(predicates: readonly ScalarPredicate[]): Promise<void> {
    const fields:string[]=[];
    for (let i=0;i<predicates.length;i++) {
      const predicate=Object.getOwnPropertyDescriptor(predicates,i)?.value as ScalarPredicate | undefined;
      if (!predicate) throw new AuthorityError('INVALID_ARGUMENT');
      if (!arrayHas(fields,predicate.field)) append(fields,predicate.field);
    }
    if (!fields.length) return;
    const result=await this.query(`SELECT field_name,ready,filterable,value_kind FROM collection_index_declarations
      WHERE space_id=$1 AND collection_id=$2 AND field_name=ANY($3::text[])`,
      [...scopeIds(this.#scope),fields]);
    if (result.rows.length!==fields.length) throw new AuthorityError('SCHEMA_CONFLICT','Filter index is not ready');
    for (let i=0;i<predicates.length;i++) {
      const predicate=Object.getOwnPropertyDescriptor(predicates,i)!.value as ScalarPredicate;
      const declared=findDeclaration(result.rows,predicate.field);
      if (declared?.ready!==true || declared.filterable!==true ||
        (predicate.kind!=='null' && declared.value_kind!==predicate.kind))
        throw new AuthorityError('SCHEMA_CONFLICT','Filter index is not ready');
    }
  }

  private async readySort(field:string):Promise<'string'|'number'|'boolean'|'date-time'> {
    const result=await this.query(`SELECT value_kind,ready,sortable FROM collection_index_declarations
      WHERE space_id=$1 AND collection_id=$2 AND field_name=$3`,[...scopeIds(this.#scope),field]);
    const row=result.rows[0];
    if (!row || row.ready!==true || row.sortable!==true || !arrayHas(['string','number','boolean','date-time'],row.value_kind))
      throw new AuthorityError('SCHEMA_CONFLICT','Sort index is not ready');
    return row.value_kind;
  }

  /** Live keyset traversal. Each page is authoritative at its own statement, not a snapshot of later pages. */
  queryPage(predicates:readonly ScalarPredicate[], limit:number, sort?:RecordSort, cursor?:string):Promise<RecordPage> {
    let fixed:readonly ScalarPredicate[],fixedSort:RecordSort|undefined;
    try { fixed=snapshotPredicates(predicates); fixedSort=snapshotSort(sort); }
    catch (error) { return Promise.reject(error); }
    return this.queryPageUsing(fixed,limit,fixedSort,cursor);
  }

  /** Worker boundary: parse primitive bytes after transaction scope admission. */
  querySerializedPage(serialized:string):Promise<RecordPage> {
    return this.admitOperation(async()=>{
      if (this.#scope.capability!=='records:read') throw new AuthorityError('FORBIDDEN');
      if (typeof serialized!=='string' || Buffer.byteLength(serialized)>32_768) throw new AuthorityError('INVALID_ARGUMENT');
      let request:Record<string,unknown>;
      try { request=JSON.parse(serialized); } catch { throw new AuthorityError('INVALID_ARGUMENT'); }
      if (!request || typeof request!=='object' || Array.isArray(request) ||
        Object.keys(request).some(key=>!arrayHas(['predicates','limit','sort','cursor'],key)) ||
        !Object.hasOwn(request,'predicates') || !Object.hasOwn(request,'limit')) throw new AuthorityError('INVALID_ARGUMENT');
      const fixed=snapshotPredicates(request.predicates as ScalarPredicate[],true);
      const fixedSort=snapshotSort(request.sort as RecordSort|undefined,true);
      return this.queryPageUsing(fixed,request.limit as number,fixedSort,request.cursor as string|undefined);
    });
  }

  private queryPageUsing(fixed:readonly ScalarPredicate[],limit:number,fixedSort?:RecordSort,cursor?:string):Promise<RecordPage> {
    return this.admitOperation(async()=>{
      if (!this.cursorSecret) throw new AuthorityError('INVALID_ARGUMENT','Cursor secret is not configured');
      if (!isSafeInteger(limit) || limit<1 || limit>MAX_PAGE) throw new AuthorityError('INVALID_ARGUMENT');
      const {params,where}=this.compilePredicates(fixed);
      await this.requireReadyIndexes(fixed);
      const kind=fixedSort ? await this.readySort(fixedSort.field) : undefined;
      const versionResult=await this.query(`SELECT schema_version FROM collections WHERE space_id=$1 AND collection_id=$2`,scopeIds(this.#scope));
      const schemaVersion=Number(versionResult.rows[0]?.schema_version);
      if (!isSafeInteger(schemaVersion)) throw new AuthorityError('SCHEMA_CONFLICT');
      const query=digestQuery(fixed,fixedSort,limit);
      const scope=this.#scope;
      const parsed=cursor===undefined ? undefined : decodeCursor(cursor,this.cursorSecret);
      if (parsed && (parsed.space!==scope.spaceId || parsed.collection!==scope.collectionId ||
        parsed.principal!==scope.principalId || parsed.credential!==scope.credentialId ||
        parsed.policy!==scope.policyVersion || parsed.placement!==scope.placementGeneration ||
        parsed.schema!==schemaVersion || parsed.query!==query)) throw new AuthorityError('INVALID_CURSOR');
      let expr='r.created_at',sortFieldParam='';
      const direction=fixedSort?.direction==='desc' ? 'DESC' : 'ASC';
      if (fixedSort) {
        params.push(fixedSort.field);
        sortFieldParam=`$${params.length}`;
        expr=kind==='date-time' ? 'stateplane_instant_sort_key(sv.time_value) COLLATE "C"' :
          `sv.${{string:'string_value',number:'number_value',boolean:'boolean_value'}[kind!]}`;
      }
      let after='',presentAfter='',missingAfter='';
      if (parsed) {
        params.push(parsed.id);
        const idParam=`$${params.length}`;
        if (parsed.value===null) {
          after=` AND ${expr} IS NULL AND r.record_id>${idParam}`;
          presentAfter=' AND FALSE';
          missingAfter=` AND r.record_id>${idParam}`;
        }
        else {
          params.push(parsed.value);
          const valueParam=`$${params.length}${fixedSort ? (kind==='number' ? '::numeric' : kind==='boolean' ? '::boolean' : '::text') : '::timestamptz'}`;
          const operator=direction==='ASC' ? '>' : '<';
          after=` AND (${expr} ${operator} ${valueParam} OR (${expr}=${valueParam} AND r.record_id>${idParam})${fixedSort ? ` OR ${expr} IS NULL` : ''})`;
          presentAfter=` AND (${expr} ${operator} ${valueParam} OR (${expr}=${valueParam} AND r.record_id>${idParam}))`;
        }
      }
      await this.query(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}ms'`);
      params.push(limit+1,limit,MAX_PAGE_BYTES);
      const candidateLimit=`$${params.length-2}`,pageLimit=`$${params.length-1}`,byteLimit=`$${params.length}`;
      const candidates=fixedSort ? `WITH present AS MATERIALIZED (
          SELECT r.record_id,${expr} AS sort_value,${expr} AS sort_cursor,octet_length(r.canonical_data) AS bytes
          FROM record_index_values sv JOIN records r ON r.space_id=sv.space_id AND r.collection_id=sv.collection_id
            AND r.record_id=sv.record_id
          WHERE ${where} AND sv.field_name=${sortFieldParam} AND sv.value_kind='${kind}'${presentAfter}
          ORDER BY ${expr} ${direction},r.record_id LIMIT ${candidateLimit}
        ), missing AS MATERIALIZED (
          SELECT r.record_id,NULL::${kind==='number' ? 'numeric' : kind==='boolean' ? 'boolean' : 'text'} AS sort_value,
            NULL::${kind==='number' ? 'numeric' : kind==='boolean' ? 'boolean' : 'text'} AS sort_cursor,
            octet_length(r.canonical_data) AS bytes
          FROM records r WHERE ${where} AND NOT EXISTS (
            SELECT 1 FROM record_index_values sv2 WHERE sv2.space_id=r.space_id AND sv2.collection_id=r.collection_id
              AND sv2.record_id=r.record_id AND sv2.field_name=${sortFieldParam} AND sv2.value_kind='${kind}'
          )${missingAfter} AND (SELECT count(*) FROM present)<${candidateLimit}
          ORDER BY r.record_id LIMIT ${candidateLimit}
        ), candidates AS MATERIALIZED (
          SELECT * FROM present UNION ALL SELECT * FROM missing
          ORDER BY sort_value ${direction} NULLS LAST,record_id LIMIT ${candidateLimit}
        )` : `WITH candidates AS MATERIALIZED (
          SELECT r.record_id,${expr} AS sort_value,
            r.created_at::text AS sort_cursor,
            octet_length(r.canonical_data) AS bytes
          FROM records r WHERE ${where}${after}
          ORDER BY ${expr} ${direction} NULLS LAST,r.record_id ASC LIMIT ${candidateLimit}
        )`;
      const result=await this.query(`${candidates}, ranked AS MATERIALIZED (
          SELECT c.*,row_number() OVER (ORDER BY c.sort_value ${direction} NULLS LAST,c.record_id) AS position,
            sum(c.bytes) OVER (ORDER BY c.sort_value ${direction} NULLS LAST,c.record_id) AS consumed
          FROM candidates c
        ), chosen AS MATERIALIZED (
          SELECT * FROM ranked WHERE position<=${pageLimit} AND consumed<=${byteLimit}
        )
        SELECT r.record_id,r.revision,r.schema_version,r.canonical_data,r.key_mode,r.normalized_key,r.tombstone,
          c.sort_value,c.sort_cursor,(SELECT EXISTS(SELECT 1 FROM ranked k WHERE k.position>${pageLimit} OR k.consumed>${byteLimit})) AS more
        FROM chosen c JOIN records r ON r.space_id=$1 AND r.collection_id=$2 AND r.record_id=c.record_id
        ORDER BY c.sort_value ${direction} NULLS LAST,c.record_id`,params);
      const records:AuthorityRecord[]=result.rows.map(row=>({ref:this.ref(row.record_id),revision:Number(row.revision),
        schemaVersion:Number(row.schema_version),canonicalData:row.canonical_data,keyMode:row.key_mode,
        normalizedKey:row.normalized_key,tombstone:row.tombstone}));
      const last=result.rows.at(-1);
      const more=Boolean(last?.more);
      return {records,schemaVersion,nextCursor:more && last ? signCursor({space:scope.spaceId,collection:scope.collectionId,
        principal:scope.principalId,credential:scope.credentialId,policy:scope.policyVersion,
        placement:scope.placementGeneration,schema:schemaVersion,query,id:last.record_id,
        value:last.sort_cursor},this.cursorSecret) : null};
    });
  }

  /** Legacy bounded read hook; new callers use queryPage for continuation. */
  queryRecords(predicates: readonly ScalarPredicate[], limit: number): Promise<AuthorityRecord[]> {
    let fixed:readonly ScalarPredicate[];
    try { fixed=snapshotPredicates(predicates); } catch (error) { return Promise.reject(error); }
    return this.admitOperation(async () => {
    if (!isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new AuthorityError('INVALID_ARGUMENT');
    const { params, where } = this.compilePredicates(fixed);
    await this.requireReadyIndexes(fixed);
    await this.query(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}ms'`);
    params.push(limit,MAX_PAGE_BYTES);
    const result = await this.query(`WITH candidates AS MATERIALIZED (
        SELECT r.record_id,r.created_at,octet_length(r.canonical_data) AS bytes FROM records r
        WHERE ${where} ORDER BY r.created_at,r.record_id LIMIT $${params.length-1}
      ), ranked AS MATERIALIZED (
        SELECT c.*,sum(c.bytes) OVER (ORDER BY c.created_at,c.record_id) AS consumed FROM candidates c
      )
      SELECT r.record_id,r.revision,r.schema_version,r.canonical_data,r.key_mode,r.normalized_key,r.tombstone
      FROM ranked c JOIN records r ON r.space_id=$1 AND r.collection_id=$2 AND r.record_id=c.record_id
      WHERE c.consumed<=$${params.length} ORDER BY c.created_at,c.record_id`, params);
    return result.rows.map(row => ({ ref:this.ref(row.record_id),revision:Number(row.revision),schemaVersion:Number(row.schema_version),
      canonicalData:row.canonical_data,keyMode:row.key_mode,normalizedKey:row.normalized_key,tombstone:row.tombstone }));
    });
  }

  /** Count records only through ready declared filter indexes. */
  countRecords(predicates: readonly ScalarPredicate[]): Promise<number> {
    let fixed:readonly ScalarPredicate[];
    try { fixed=snapshotPredicates(predicates); } catch (error) { return Promise.reject(error); }
    return this.countUsing(fixed);
  }
  countSerializedRecords(serialized:string):Promise<number> {
    return this.admitOperation(()=>{
      if (this.#scope.capability!=='records:read') throw new AuthorityError('FORBIDDEN');
      return this.countUsing(parseSerializedPredicates(serialized));
    });
  }
  private countUsing(fixed:readonly ScalarPredicate[]):Promise<number> {
    return this.admitOperation(async () => {
    const { params, where } = this.compilePredicates(fixed);
    await this.requireReadyIndexes(fixed);
    await this.query(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}ms'`);
    const result = await this.query(`SELECT count(*)::bigint AS total FROM records r WHERE ${where}`,params);
    const count = Number(result.rows[0].total);
    if (!isSafeInteger(count)) throw new RangeError('Count exceeds JavaScript safe integer range');
    return count;
    });
  }

  /** Test record existence with the same indexed predicate contract as count. */
  existsRecord(predicates: readonly ScalarPredicate[]): Promise<boolean> {
    let fixed:readonly ScalarPredicate[];
    try { fixed=snapshotPredicates(predicates); } catch (error) { return Promise.reject(error); }
    return this.existsUsing(fixed);
  }
  existsSerializedRecord(serialized:string):Promise<boolean> {
    return this.admitOperation(()=>{
      if (this.#scope.capability!=='records:read') throw new AuthorityError('FORBIDDEN');
      return this.existsUsing(parseSerializedPredicates(serialized));
    });
  }
  private existsUsing(fixed:readonly ScalarPredicate[]):Promise<boolean> {
    return this.admitOperation(async () => {
    const { params, where } = this.compilePredicates(fixed);
    await this.requireReadyIndexes(fixed);
    await this.query(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}ms'`);
    const result = await this.query(`SELECT EXISTS(SELECT 1 FROM records r WHERE ${where}) AS found`,params);
    return result.rows[0].found;
    });
  }

  /** Claim only this collection's due jobs. Attempt number fences late workers after lease expiry. */
  claimOutbox(limit: number, leaseSeconds: number): Promise<OutboxDelivery[]> {
    return this.admitOperation(async () => {
    if (this.#scope.capability !== 'outbox:worker') throw new AuthorityError('FORBIDDEN');
    if (!isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE || !isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new AuthorityError('INVALID_ARGUMENT');
    const result = await this.query(`UPDATE projection_outbox o SET delivery_state='delivering',attempts=o.attempts+1,
      available_at=clock_timestamp()+($3::integer * interval '1 second')
      FROM (SELECT event_id FROM projection_outbox WHERE space_id=$1 AND collection_id=$2
        AND delivery_state IN ('pending','delivering','degraded') AND available_at<=clock_timestamp()
        ORDER BY available_at,event_id FOR UPDATE SKIP LOCKED LIMIT $4) due
      WHERE o.event_id=due.event_id RETURNING o.event_id,o.record_id,o.revision,o.generation,o.attempts`,
    [...scopeIds(this.#scope),leaseSeconds,limit]);
    return result.rows.map(row => ({ eventId:row.event_id,ref:this.ref(row.record_id),revision:Number(row.revision),
      generation:Number(row.generation),attempt:row.attempts }));
    },true);
  }

  /** Finish only the still-current leased outbox attempt. */
  finishOutbox(delivery: OutboxDelivery, success: boolean, error?: string): Promise<boolean> {
    return this.admitOperation(async () => {
    if (this.#scope.capability !== 'outbox:worker') throw new AuthorityError('FORBIDDEN');
    if (!scalarString(delivery.eventId) || typeof success !== 'boolean' || !isSafeInteger(delivery.attempt) || delivery.attempt < 1 ||
      (error !== undefined && (typeof error !== 'string' || error.includes('\0') || error.length > 4096))) throw new AuthorityError('INVALID_ARGUMENT');
    const result = await this.query(`UPDATE projection_outbox SET delivery_state=$5,
      delivered_at=CASE WHEN $5='delivered' THEN clock_timestamp() ELSE NULL END,
      last_error=$6,available_at=CASE WHEN $5='delivered' THEN clock_timestamp()
        ELSE clock_timestamp() + (LEAST(3600, 5 * (1 << LEAST(attempts-1, 10))) * interval '1 second') END
      WHERE space_id=$1 AND collection_id=$2 AND event_id=$3 AND attempts=$4
        AND revision=$7 AND generation=$8 AND delivery_state='delivering'
        AND available_at>clock_timestamp()`,
    [...scopeIds(this.#scope),delivery.eventId,delivery.attempt,success ? 'delivered' : 'degraded',success ? null : (error ?? 'projection failed'),
      delivery.revision,delivery.generation]);
    return result.rowCount === 1;
    },true);
  }
}

export * from './spaces.js';
export * from './cell-policy.js';
