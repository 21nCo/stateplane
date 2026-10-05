import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { AuthorityError } from './index.js';
import type { IndexValue, UniqueValue } from './index.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface SchemaNode {
  $schema?: string; type: string | string[]; properties?: Record<string, SchemaNode>;
  required?: string[]; additionalProperties?: false; items?: SchemaNode;
  minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; enum?: Json[]; format?: 'date-time'; description?: string;
}
export interface CollectionDefinition {
  slug: string; version: number; schema: SchemaNode;
  unique: Array<{ name: string; paths: string[] }>;
  filterable: string[]; sortable: string[];
  lifecycle?: { field: string; initial: string[]; transitions: Record<string, string[]> };
}

const allowed = new Set(['$schema','type','properties','required','additionalProperties','items','minItems','maxItems','minLength','maxLength','minimum','maximum','enum','format','description']);
const typesAllowed = new Set(['string','integer','number','boolean','object','array']);
const maxBytes = 1_048_576;
const maxDepth = 32;
const maxCanonicalDepth = 64;
const maxFields = 256;
// Keep each B-tree tuple well below PostgreSQL's roughly one-third-page entry
// limit even when the scoped identifiers and value share a multicolumn index.
export const MAX_INDEX_PART_BYTES = 256;
export const MAX_INDEX_VALUE_BYTES = 512;
const withinBytes = (value:string, limit:number):boolean => Buffer.byteLength(value,'utf8') <= limit;
const own = Object.hasOwn;
const isFiniteNumber = Number.isFinite;
const isIntegerNumber = Number.isInteger;
const isSafeInteger = Number.isSafeInteger;
const normalize = String.prototype.normalize;
const codeUnit = String.prototype.charCodeAt;
const slice = String.prototype.slice;
const startsWith = String.prototype.startsWith;
const endsWith = String.prototype.endsWith;
const nativeSort = Array.prototype.sort;
const nativeJoin = Array.prototype.join;
const nativeRegexExec = RegExp.prototype.exec;
const nativeSetHas = Set.prototype.has;
const nativeSetAdd = Set.prototype.add;
const nativeSetDelete = Set.prototype.delete;
const NativeDate = Date;
const nativeGetTime = Date.prototype.getTime;
const nativeISOString = Date.prototype.toISOString;
const proxyDetector=(()=>{
  if (typeof types.isProxy!=='function') return null;
  try {
    if (types.isProxy({})!==false || types.isProxy(new Proxy({},{}))!==true) return null;
    return types.isProxy;
  } catch { return null; }
})();
export const acceptsInProcessObjects=proxyDetector!==null;
/** Treat objects as unsafe when the runtime cannot reliably detect proxies. */
export const isInProcessProxy = (value:unknown):boolean => proxyDetector ? proxyDetector(value) : true;
const compare = (a: string,b: string) => Buffer.compare(Buffer.from(a),Buffer.from(b));
const append = <T>(values:T[],value:T):void => { Object.defineProperty(values,values.length,{value,writable:true,configurable:true,enumerable:true}); };
const includes = <T>(values:readonly T[],value:T):boolean => {
  for (let i=0;i<values.length;i++) if (Object.getOwnPropertyDescriptor(values,i)?.value===value) return true;
  return false;
};
const distinct = (values:readonly unknown[]):boolean => {
  for (let i=0;i<values.length;i++) for (let j=0;j<i;j++) if (Object.getOwnPropertyDescriptor(values,i)?.value===Object.getOwnPropertyDescriptor(values,j)?.value) return false;
  return true;
};
const any = <T>(values:readonly T[],predicate:(value:T)=>boolean):boolean => {
  for (let i=0;i<values.length;i++) if (predicate(Object.getOwnPropertyDescriptor(values,i)!.value)) return true;
  return false;
};
const sorted = <T>(values:T[],comparison:(a:T,b:T)=>number):T[] => Reflect.apply(nativeSort,values,[comparison]) as T[];
const joined = (values:readonly string[],separator:string):string => Reflect.apply(nativeJoin,values,[separator]) as string;
const setHas = <T>(set:Set<T>,value:T):boolean => Reflect.apply(nativeSetHas,set,[value]) as boolean;
const setAdd = <T>(set:Set<T>,value:T):void => { Reflect.apply(nativeSetAdd,set,[value]); };
const setDelete = <T>(set:Set<T>,value:T):void => { Reflect.apply(nativeSetDelete,set,[value]); };
const scalarLength=(value:string):number=>{
  let count=0;
  for (let i=0;i<value.length;i++) {
    const unit=Reflect.apply(codeUnit,value,[i]) as number;
    if (unit>=0xd800 && unit<=0xdbff) i++;
    count++;
  }
  return count;
};
const ordinary = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
  !proxyDetector?.(value) && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fail = (code: string, message?: string): never => { throw new AuthorityError(code,message); };

/** Reject unpaired surrogates and, for identifiers, U+0000. */
export function scalarString(value: unknown, allowNul = false): value is string {
  if (typeof value !== 'string') return false;
  for (let i=0;i<value.length;i++) {
    const unit = Reflect.apply(codeUnit,value,[i]) as number;
    if ((!allowNul && unit === 0) || (unit >= 0xdc00 && unit <= 0xdfff)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = Reflect.apply(codeUnit,value,[++i]) as number;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    }
  }
  return true;
}
/** Admit bounded ordinary JSON without invoking accessors or proxy traps. */
export function plainJson(value: unknown, code = 'SCHEMA_INVALID', depth = 0, seen = new Set<object>(), trustedParsed = false,
  budget?: { nodes:number; bytes:number }): asserts value is Json {
  budget ??= { nodes:0, bytes:0 };
  chargeJsonBudget(value,code,budget);
  if ((!trustedParsed && (!proxyDetector || proxyDetector(value))) || depth > maxCanonicalDepth) fail(code);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (!scalarString(value,true)) fail(code);
    return;
  }
  if (typeof value === 'number') {
    if (!isFiniteNumber(value)) fail(code);
    return;
  }
  if (!ordinary(value) && !Array.isArray(value)) fail(code);
  const object = value as object;
  if (setHas(seen,object)) fail(code);
  setAdd(seen,object);
  if (Array.isArray(value)) validateJsonArray(value,code,depth,seen,trustedParsed,budget);
  else validateJsonObject(object,code,depth,seen,trustedParsed,budget);
  setDelete(seen,object);
}
/** Charge each JSON occurrence before traversing shared in-process references. */
function chargeJsonBudget(value:unknown,code:string,budget:{nodes:number;bytes:number}):void {
  // Shared-reference DAGs are legal in-process input. Charge each occurrence,
  // not each distinct object, before canonical expansion can multiply it.
  if (++budget.nodes > maxBytes) fail(code,'JSON exceeds node budget');
  budget.bytes += value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
    ? Buffer.byteLength(JSON.stringify(value)) : 2;
  if (budget.bytes > maxBytes) fail(code,'JSON exceeds byte budget');
}
/** Inspect every array slot as an own data property without invoking getters. */
function validateJsonArray(value:unknown[],code:string,depth:number,seen:Set<object>,trustedParsed:boolean,
  budget:{nodes:number;bytes:number}):void {
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length+1) fail(code);
  for (let i=0;i<value.length;i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value,i);
    if (!descriptor?.enumerable || !own(descriptor,'value')) fail(code);
    if (i) budget.bytes++;
    plainJson(descriptor!.value,code,depth+1,seen,trustedParsed,budget);
  }
}
/** Inspect object keys and values without trusting the object's prototype. */
function validateJsonObject(object:object,code:string,depth:number,seen:Set<object>,trustedParsed:boolean,
  budget:{nodes:number;bytes:number}):void {
  const keys=Reflect.ownKeys(object);
  for (let i=0;i<keys.length;i++) {
    const key=Object.getOwnPropertyDescriptor(keys,i)!.value as PropertyKey;
    const descriptor = Object.getOwnPropertyDescriptor(object,key);
    if (typeof key !== 'string' || !scalarString(key) || !descriptor?.enumerable || !own(descriptor,'value')) fail(code);
    budget.bytes += Buffer.byteLength(JSON.stringify(key))+1+(i ? 1 : 0);
    if (budget.bytes > maxBytes) fail(code,'JSON exceeds byte budget');
    plainJson(descriptor!.value,code,depth+1,seen,trustedParsed,budget);
  }
}
/** Serialize already admitted JSON in stable UTF-8 key order. */
export function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts: string[]=[];
    for (let i=0;i<value.length;i++) append(parts,canonical(Object.getOwnPropertyDescriptor(value,i)!.value));
    return `[${joined(parts,',')}]`;
  }
  const keys=sorted(Object.keys(value),compare);
  const fields:string[]=[];
  for (let i=0;i<keys.length;i++) {
    const key=Object.getOwnPropertyDescriptor(keys,i)!.value as string;
    append(fields,`${JSON.stringify(key)}:${canonical(Object.getOwnPropertyDescriptor(value,key)!.value)}`);
  }
  return `{${joined(fields,',')}}`;
}
/** Hash the canonical representation used by receipt replay. */
export function fingerprint(value: Json): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
/** Resolve the declared scalar kind, including a null-first union. */
const typeOf = (node: SchemaNode) => {
  if (!Array.isArray(node.type)) return node.type;
  return node.type[0]==='null' ? node.type[1] : node.type[0];
};
const nullable = (node: SchemaNode) => Array.isArray(node.type);
const props = (node: SchemaNode) => own(node,'properties') ? node.properties! : Object.create(null) as Record<string,SchemaNode>;
const list = (value: unknown, code: string): unknown[] => {
  if (!Array.isArray(value)) fail(code);
  const members=value as unknown[];
  if (Object.getPrototypeOf(members)!==Array.prototype || Reflect.ownKeys(members).length!==members.length+1) fail(code);
  for (let i=0;i<members.length;i++) {
    const descriptor=Object.getOwnPropertyDescriptor(members,i);
    if (!descriptor?.enumerable || !own(descriptor,'value')) fail(code);
  }
  return members;
};
/** Validate one node of the closed schema subset within shared depth and node budgets. */
function validateNode(node: SchemaNode, root: boolean, depth: number, counter: { count: number }): void {
  node=validateNodeEnvelope(node,root,depth,counter);
  const kind=schemaKind(node.type);
  if (root && kind !== 'object') fail('SCHEMA_UNSUPPORTED');
  if (own(node,'description') && (typeof node.description !== 'string' || !scalarString(node.description,true))) fail('SCHEMA_UNSUPPORTED');
  validateNodeBounds(node,kind);
  validateChildNodes(node,kind,depth,counter);
  if (own(node,'enum')) validateNodeEnum(node,depth);
}
/** Snapshot a schema node and reject unsupported keywords before inspecting values. */
function validateNodeEnvelope(node:SchemaNode,root:boolean,depth:number,counter:{count:number}):SchemaNode {
  if (!ordinary(node) || depth > maxDepth || ++counter.count > maxFields) fail('SCHEMA_UNSUPPORTED','Schema exceeds node/depth budget');
  node=Object.assign(Object.create(null),node) as SchemaNode;
  const nodeKeys=Object.keys(node);
  for (let i=0;i<nodeKeys.length;i++) {
    const key=Object.getOwnPropertyDescriptor(nodeKeys,i)!.value as string;
    if (!setHas(allowed,key)) fail('SCHEMA_UNSUPPORTED',`Unsupported keyword: ${key}`);
  }
  if (!own(node,'type') || (root ? !own(node,'$schema') || node.$schema !== 'https://json-schema.org/draft/2020-12/schema' : own(node,'$schema'))) fail('SCHEMA_UNSUPPORTED');
  return node;
}
/** Recurse only through children declared for the admitted node kind. */
function validateChildNodes(node:SchemaNode,kind:string,depth:number,counter:{count:number}):void {
  if (kind === 'object') validateObjectNode(node,depth,counter);
  else if (own(node,'properties') || own(node,'required') || own(node,'additionalProperties')) fail('SCHEMA_UNSUPPORTED');
  if (kind === 'array') {
    if (!own(node,'items')) fail('SCHEMA_UNSUPPORTED');
    validateNode(node.items!,false,depth+1,counter);
  }
  else if (own(node,'items') || own(node,'minItems') || own(node,'maxItems')) fail('SCHEMA_UNSUPPORTED');
}
/** Admit only scalar nullable unions and the closed set of schema types. */
function schemaKind(spec:SchemaNode['type']):string {
  if (typeof spec === 'string' && setHas(typesAllowed,spec)) return spec;
  if (Array.isArray(spec) && list(spec,'SCHEMA_UNSUPPORTED').length === 2 &&
    ((spec[1] === 'null' && includes(['string','integer','number','boolean'],spec[0])) ||
      (spec[0] === 'null' && includes(['string','integer','number','boolean'],spec[1])))) return spec[0]==='null' ? spec[1] : spec[0];
  return fail('SCHEMA_UNSUPPORTED','Unsupported type');
}
/** Check type-specific limits before validating child schema nodes. */
function validateNodeBounds(node:SchemaNode,kind:string):void {
  validateSizeBounds(node,kind,'minLength','maxLength','string');
  validateSizeBounds(node,kind,'minItems','maxItems','array');
  validateNumericBounds(node,kind);
  if (own(node,'format') && (kind !== 'string' || node.format !== 'date-time')) fail('SCHEMA_UNSUPPORTED');
}
/** Admit nonnegative integral size bounds only for their matching type. */
function validateSizeBounds(node:SchemaNode,kind:string,min:'minLength'|'minItems',max:'maxLength'|'maxItems',expected:string):void {
  if (!own(node,min) && !own(node,max)) return;
  if (kind !== expected) fail('SCHEMA_UNSUPPORTED');
  if (own(node,min) && (!isIntegerNumber(node[min]) || (node[min] as number)<0)) fail('SCHEMA_UNSUPPORTED');
  if (own(node,max) && (!isIntegerNumber(node[max]) || (node[max] as number)<0)) fail('SCHEMA_UNSUPPORTED');
  if (own(node,min) && own(node,max) && (node[min] as number)>(node[max] as number)) fail('SCHEMA_UNSUPPORTED');
}
/** Admit finite numeric bounds only for number and integer nodes. */
function validateNumericBounds(node:SchemaNode,kind:string):void {
  if (own(node,'minimum') || own(node,'maximum')) {
    if (kind !== 'number' && kind !== 'integer') fail('SCHEMA_UNSUPPORTED');
    if (own(node,'minimum') && (typeof node.minimum !== 'number' || !isFiniteNumber(node.minimum))) fail('SCHEMA_UNSUPPORTED');
    if (own(node,'maximum') && (typeof node.maximum !== 'number' || !isFiniteNumber(node.maximum))) fail('SCHEMA_UNSUPPORTED');
    if (own(node,'minimum') && own(node,'maximum') && node.minimum!>node.maximum!) fail('SCHEMA_UNSUPPORTED');
  }
}
/** Validate declared fields and required names without inherited-key admission. */
function validateObjectNode(node:SchemaNode,depth:number,counter:{count:number}):void {
  if (!own(node,'additionalProperties') || node.additionalProperties !== false || own(node,'items') || own(node,'minItems') || own(node,'maxItems')) fail('SCHEMA_UNSUPPORTED');
  if (own(node,'properties') && !ordinary(node.properties)) fail('SCHEMA_UNSUPPORTED');
  const entries = Object.entries(props(node));
  for (let i=0;i<entries.length;i++) {
    const pair=Object.getOwnPropertyDescriptor(entries,i)!.value as [string,SchemaNode];
    const key=pair[0],child=pair[1];
    if (!scalarString(key) || !withinBytes(key,MAX_INDEX_PART_BYTES)) fail('SCHEMA_UNSUPPORTED','Field name exceeds indexed byte limit');
    validateNode(child,false,depth+1,counter);
  }
  if (own(node,'required')) {
    const required = list(node.required,'SCHEMA_UNSUPPORTED');
    if (!distinct(required) || any(required,key=>typeof key !== 'string' || !own(props(node),key))) fail('SCHEMA_UNSUPPORTED');
  }
}
/** Validate enum members against the same node without the enum recursion. */
function validateNodeEnum(node:SchemaNode,depth:number):void {
  const members = list(node.enum,'SCHEMA_UNSUPPORTED');
  if (!members.length) fail('SCHEMA_UNSUPPORTED');
  const canonicalMembers:string[]=[];
  for (let i=0;i<members.length;i++) append(canonicalMembers,canonical(members[i] as Json)); // NOSONAR -- own-slot scan avoids replaced array iterators
  if (!distinct(canonicalMembers)) fail('SCHEMA_UNSUPPORTED');
  for (let i=0;i<members.length;i++) {
    const member=Object.getOwnPropertyDescriptor(members,i)!.value;
    try { validateParsedValue(member as Json,{...node,enum:undefined},depth); }
    catch { fail('SCHEMA_UNSUPPORTED','Invalid enum member'); }
  }
}
const leapDays = new Set(['1972-06-30','1972-12-31','1973-12-31','1974-12-31','1975-12-31','1976-12-31','1977-12-31','1978-12-31','1979-12-31','1981-06-30','1982-06-30','1983-06-30','1985-06-30','1987-12-31','1989-12-31','1990-12-31','1992-06-30','1993-06-30','1994-06-30','1995-12-31','1997-06-30','1998-12-31','2005-12-31','2008-12-31','2012-06-30','2015-06-30','2016-12-31']);
/** Normalize an accepted UTC instant while preserving precise fractional ordering. */
export function utcInstant(value: string): string {
  const match=Reflect.apply(nativeRegexExec,/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/,[value]) as RegExpExecArray | null;
  if (!match || Reflect.apply(startsWith,match[1],['0000-'])) fail('SCHEMA_INVALID');
  const checkedMatch=match!;
  const leap=Reflect.apply(endsWith,checkedMatch[1],['T23:59:60']) as boolean;
  if (Reflect.apply(endsWith,checkedMatch[1],[':60']) &&
    (!leap || !setHas(leapDays,Reflect.apply(slice,checkedMatch[1],[0,10]) as string))) fail('SCHEMA_INVALID');
  const checked=leap ? `${Reflect.apply(slice,checkedMatch[1],[0,-2])}59` : checkedMatch[1];
  const instant=new NativeDate(`${checked}Z`);
  if (!isFiniteNumber(Reflect.apply(nativeGetTime,instant,[])) ||
    (Reflect.apply(slice,Reflect.apply(nativeISOString,instant,[]) as string,[0,19]) as string)!==checked) fail('SCHEMA_INVALID');
  let fraction=checkedMatch[2]??'';
  while (fraction.length && Reflect.apply(codeUnit,fraction,[fraction.length-1])===48)
    fraction=Reflect.apply(slice,fraction,[0,-1]) as string;
  const suffix=fraction ? '.'+fraction : '';
  return `${checkedMatch[1]}${suffix}Z`;
}
/** Validate caller-owned JSON and schema without trusting a serialized provenance claim. */
export function validateValue(value: Json, node: SchemaNode): void {
  plainJson(value);
  plainJson(node);
  validateParsedValue(value,node);
}
/** Validate JSON admitted by the parser or a checked in-process snapshot. */
export function validateParsedValue(value: Json, node: SchemaNode, depth=0): void {
  if (depth > maxDepth) fail('SCHEMA_INVALID');
  node=Object.assign(Object.create(null),node) as SchemaNode;
  const kind=typeOf(node);
  if (value === null) { if (!nullable(node)) fail('SCHEMA_INVALID'); }
  else if (kind==='object') validateObjectValue(value,node,depth);
  else if (kind==='array') validateArrayValue(value,node,depth);
  else if (kind==='string') validateStringValue(value,node);
  else if (kind==='boolean') { if (typeof value!=='boolean') fail('SCHEMA_INVALID'); }
  else validateNumberValue(value,node,kind);
  if (node.enum && !any(node.enum,member=>canonical(member)===canonical(value))) fail('SCHEMA_INVALID');
}
/** Validate declared object members and required own fields. */
function validateObjectValue(value:Json,node:SchemaNode,depth:number):void {
  if (!ordinary(value)) fail('SCHEMA_INVALID');
  const entries=Object.entries(value as Record<string,Json>);
  for (let i=0;i<entries.length;i++) {
    const pair=Object.getOwnPropertyDescriptor(entries,i)!.value as [string,Json];
    const key=pair[0],item=pair[1];
    if (!own(props(node),key)) fail('SCHEMA_INVALID');
    validateParsedValue(item,props(node)[key],depth+1);
  }
  const required=node.required??[];
  for (let i=0;i<required.length;i++) if (!own(value as object,Object.getOwnPropertyDescriptor(required,i)!.value)) fail('SCHEMA_INVALID');
}
/** Validate array length before walking its already admitted members. */
function validateArrayValue(value:Json,node:SchemaNode,depth:number):void {
  if (!Array.isArray(value) || (node.minItems!==undefined && value.length<node.minItems) || (node.maxItems!==undefined && value.length>node.maxItems)) fail('SCHEMA_INVALID');
  const members=value as Json[];
  for (let i=0;i<members.length;i++) validateParsedValue(members[i],node.items!,depth+1); // NOSONAR -- own-slot scan avoids replaced array iterators
}
/** Enforce Unicode scalar length and the declared UTC format. */
function validateStringValue(value:Json,node:SchemaNode):void {
  if (typeof value!=='string' || !scalarString(value,true)) fail('SCHEMA_INVALID');
  const text=value as string;
  const length=scalarLength(text);
  if ((node.minLength!==undefined && length<node.minLength) || (node.maxLength!==undefined && length>node.maxLength)) fail('SCHEMA_INVALID');
  if (node.format==='date-time') utcInstant(text);
}
/** Enforce finite numeric bounds and safe integer representation. */
function validateNumberValue(value:Json,node:SchemaNode,kind:string):void {
  if (typeof value!=='number' || !isFiniteNumber(value) || (kind==='integer' && !isSafeInteger(value)) ||
    (node.minimum!==undefined && value<node.minimum) || (node.maximum!==undefined && value>node.maximum)) fail('SCHEMA_INVALID');
}
const scalarField = (schema: SchemaNode, path: unknown): path is string => typeof path==='string' && path.length>0 && scalarString(path) &&
  own(props(schema),path) && includes(['string','number','integer','boolean'],typeOf(props(schema)[path]));
/** Admit caller-owned definitions without exposing a trusted-parser switch. */
export function validateDefinition(input: unknown): CollectionDefinition {
  return validateParsedDefinition(input,false);
}
/** Admit a definition already parsed from serialized JSON or a checked snapshot. */
export function validateParsedDefinition(input: unknown, trustedParsed = true): CollectionDefinition {
  plainJson(input,'SCHEMA_UNSUPPORTED',0,new Set<object>(),trustedParsed);
  if (!ordinary(input) || any(Object.keys(input),key=>!includes(['slug','version','schema','unique','filterable','sortable','lifecycle'],key))) fail('SCHEMA_UNSUPPORTED');
  const definition=input as unknown as CollectionDefinition;
  if (!own(definition,'slug') || !own(definition,'version') || !own(definition,'schema')) fail('SCHEMA_UNSUPPORTED');
  if (!scalarString(definition.slug) || !definition.slug || !withinBytes(definition.slug,MAX_INDEX_PART_BYTES) || !isSafeInteger(definition.version) || definition.version<1) fail('SCHEMA_UNSUPPORTED');
  validateNode(definition.schema,true,0,{count:0});
  if (!own(definition,'unique') || !own(definition,'filterable') || !own(definition,'sortable')) fail('SCHEMA_UNSUPPORTED');
  validateUniqueDeclarations(definition);
  validateScalarDeclarations(definition);
  if (own(definition,'lifecycle')) validateLifecycle(definition);
  const encoded=canonical(definition as unknown as Json);
  if (Buffer.byteLength(encoded)>maxBytes) fail('SCHEMA_UNSUPPORTED','Definition exceeds byte budget');
  return JSON.parse(encoded) as CollectionDefinition;
}
/** Check immutable unique names and paths against scalar root fields. */
function validateUniqueDeclarations(definition:CollectionDefinition):void {
  const uniques=list(definition.unique,'SCHEMA_UNSUPPORTED');
  if (uniques.length>16) fail('SCHEMA_UNSUPPORTED','Unique reservation limit exceeded');
  const names:string[]=[];
  for (let i=0;i<uniques.length;i++) {
    const entry=Object.getOwnPropertyDescriptor(uniques,i)!.value;
    if (!ordinary(entry) || Reflect.ownKeys(entry).length!==2 || !own(entry,'name') || !own(entry,'paths')) fail('SCHEMA_UNSUPPORTED');
    const item=entry as {name:unknown;paths:unknown};
    const paths=list(item.paths,'SCHEMA_UNSUPPORTED');
    if (!scalarString(item.name) || !item.name || !withinBytes(item.name,MAX_INDEX_PART_BYTES) || includes(names,item.name) || !paths.length || !distinct(paths) || any(paths,path=>!scalarField(definition.schema,path))) fail('SCHEMA_UNSUPPORTED');
    append(names,item.name as string);
  }
}
/** Check declared filter and sort paths without admitting duplicates. */
function validateScalarDeclarations(definition:CollectionDefinition):void {
  const declarations=['filterable','sortable'] as const;
  const combined:string[]=[];
  const uniques=list(definition.unique,'SCHEMA_UNSUPPORTED');
  for (let i=0;i<uniques.length;i++) {
    const paths=list((Object.getOwnPropertyDescriptor(uniques,i)!.value as {paths:unknown}).paths,'SCHEMA_UNSUPPORTED');
    for (let j=0;j<paths.length;j++) {
      const path=Object.getOwnPropertyDescriptor(paths,j)!.value as string;
      if (!includes(combined,path)) append(combined,path);
    }
  }
  for (let i=0;i<declarations.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const key=declarations[i];
    const paths=list(definition[key],'SCHEMA_UNSUPPORTED');
    if (!distinct(paths) || any(paths,path=>!scalarField(definition.schema,path))) fail('SCHEMA_UNSUPPORTED');
    for (let j=0;j<paths.length;j++) if (!includes(combined,paths[j])) append(combined,paths[j]);
  }
  if (combined.length>16) fail('SCHEMA_UNSUPPORTED','Indexed field limit exceeded');
}
/** Restrict lifecycle data to a required enum field and declared transitions. */
function validateLifecycle(definition:CollectionDefinition):void {
  const rule=definition.lifecycle;
  if (!ordinary(rule) || joined(sorted(Object.keys(rule),compare),',')!=='field,initial,transitions' || !scalarField(definition.schema,rule.field) ||
    typeOf(props(definition.schema)[rule.field])!=='string' || nullable(props(definition.schema)[rule.field]) ||
    !includes(own(definition.schema,'required') ? definition.schema.required! : [],rule.field) || !ordinary(rule.transitions) ||
    !own(props(definition.schema)[rule.field],'enum')) fail('SCHEMA_UNSUPPORTED');
  if (any(list(rule!.initial,'SCHEMA_UNSUPPORTED'),value=>!includes(props(definition.schema)[rule!.field].enum!,value as Json))) fail('SCHEMA_UNSUPPORTED');
  const transitions=Object.entries(rule!.transitions);
  for (let i=0;i<transitions.length;i++) {
    const pair=Object.getOwnPropertyDescriptor(transitions,i)!.value as [string,string[]];
    const from=pair[0],tos=pair[1];
    if (!includes(props(definition.schema)[rule!.field].enum!,from) ||
      any(list(tos,'SCHEMA_UNSUPPORTED'),to=>!includes(props(definition.schema)[rule!.field].enum!,to as Json))) fail('SCHEMA_UNSUPPORTED');
  }
}
/** Remove only descriptions when comparing immutable constraints. */
function withoutAnnotations(node: SchemaNode): Json {
  const clone:Record<string,Json>=Object.create(null);
  const keys=Object.keys(node) as Array<keyof SchemaNode>;
  for (let i=0;i<keys.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const key=keys[i];
    if (key==='description') continue;
    if (key==='properties') {
      const children:Record<string,Json>=Object.create(null);
      const names=Object.keys(props(node));
      for (let j=0;j<names.length;j++) { // NOSONAR -- own-slot scan avoids replaced array iterators
        const name=names[j];
        Object.defineProperty(children,name,{value:withoutAnnotations(props(node)[name]),enumerable:true,writable:true,configurable:true});
      }
      clone.properties=children;
    } else if (key==='items') clone.items=withoutAnnotations(node.items!);
    else if (key==='required' || key==='enum' || key==='type' && Array.isArray(node.type)) {
      const values=node[key] as Json[];
      const members:string[]=[];
      for (let j=0;j<values.length;j++) append(members,canonical(Object.getOwnPropertyDescriptor(values,j)!.value));
      clone[key]=sorted(members,compare);
    } else clone[key]=node[key] as Json;
  }
  return clone;
}
/** Check caller-owned definitions before comparing their compatibility. */
export function compatible(old: CollectionDefinition, next: CollectionDefinition): void {
  plainJson(old,'SCHEMA_UNSUPPORTED');
  plainJson(next,'SCHEMA_UNSUPPORTED');
  compatibleParsed(old,next);
}
/** Compare definitions returned by the trusted definition parser. */
export function compatibleParsed(old: CollectionDefinition, next: CollectionDefinition): void {
  if (old.slug!==next.slug || next.version!==old.version+1 || canonical(old.unique as unknown as Json)!==canonical(next.unique as unknown as Json) ||
    canonical((own(old,'lifecycle') ? old.lifecycle! : null) as Json)!==canonical((own(next,'lifecycle') ? next.lifecycle! : null) as Json)) fail('SCHEMA_BREAKING','Slug, uniqueness or lifecycle change requires migration');
  compatibleFields(old,next);
  const compatibleDeclarations=['filterable','sortable'] as const;
  for (let i=0;i<compatibleDeclarations.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const key=compatibleDeclarations[i];
    if (any(old[key],name=>!includes(next[key],name))) fail('SCHEMA_BREAKING',`${key} cannot be removed`);
  }
}
/** Reject changed or newly required fields while allowing additive optional fields. */
function compatibleFields(old:CollectionDefinition,next:CollectionDefinition):void {
  const oldProps=props(old.schema), nextProps=props(next.schema);
  const names=Object.keys(oldProps);
  for (let i=0;i<names.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const name=names[i],oldNode=oldProps[name];
    if (!own(nextProps,name) || canonical(withoutAnnotations(oldNode))!==canonical(withoutAnnotations(nextProps[name]))) fail('SCHEMA_BREAKING',`Existing field ${name} changed`);
  }
  const a={...old.schema,properties:{}} as SchemaNode,b={...next.schema,properties:{}} as SchemaNode;
  if (canonical(withoutAnnotations(a))!==canonical(withoutAnnotations(b))) fail('SCHEMA_BREAKING','Root constraints changed');
  const nextNames=Object.keys(nextProps);
  for (let i=0;i<nextNames.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const name=nextNames[i];
    if (!own(oldProps,name) && includes(own(next.schema,'required') ? next.schema.required! : [],name))
      fail('SCHEMA_BREAKING',`New field ${name} must be optional`);
  }
}
const whites = new Set([0x20,0x85,0xa0,0x1680,0x2028,0x2029,0x202f,0x205f,0x3000]);
for (let i=9;i<=13;i++) whites.add(i);
for (let i=0x2000;i<=0x200a;i++) whites.add(i);
/** Normalize a caller key using the fixed v1 Unicode trim and NFC rule. */
export function externalKey(value: unknown): string {
  if (!scalarString(value)) fail('INVALID_ARGUMENT');
  const n=Reflect.apply(normalize,value,['NFC']) as string;
  let start=0,end=n.length;
  while (start<end && setHas(whites,Reflect.apply(codeUnit,n,[start]) as number)) start++;
  while (end>start && setHas(whites,Reflect.apply(codeUnit,n,[end-1]) as number)) end--;
  const result=Reflect.apply(slice,n,[start,end]) as string;
  if (!result || !withinBytes(result,MAX_INDEX_PART_BYTES)) fail('INVALID_ARGUMENT','External key exceeds indexed byte limit');
  return result;
}
/** Derive values only after admitting caller-owned data and definition objects. */
export function derivedValues(data: Record<string,Json>, definition: CollectionDefinition): {unique: UniqueValue[]; indexes: IndexValue[]} {
  plainJson(data);
  plainJson(definition);
  return derivedParsedValues(data,definition);
}
/** Derive atomic facts from parsed or previously admitted JSON. */
export function derivedParsedValues(data: Record<string,Json>, definition: CollectionDefinition): {unique: UniqueValue[]; indexes: IndexValue[]} {
  const unique=derivedUniqueValues(data,definition);
  const indexes:IndexValue[]=[];
  const fields:string[]=[];
  const pathLists=[definition.filterable,definition.sortable];
  for (let j=0;j<pathLists.length;j++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const paths=pathLists[j];
    for (let i=0;i<paths.length;i++) if (!includes(fields,paths[i])) append(fields,paths[i]); // NOSONAR -- own-slot scan avoids replaced array iterators
  }
  for (let i=0;i<fields.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const field=fields[i];
    const index=derivedIndexValue(data,definition,field);
    if (index) append(indexes,index);
  }
  return {unique,indexes};
}
/** Encode present, non-null unique tuples with stable type and byte lengths. */
function derivedUniqueValues(data:Record<string,Json>,definition:CollectionDefinition):UniqueValue[] {
  const unique:UniqueValue[]=[];
  for (let i=0;i<definition.unique.length;i++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const item=definition.unique[i];
    const encodedValue=encodeUniqueTuple(data,definition,item.paths);
    if (encodedValue!==undefined) append(unique,{name:item.name,encodedValue});
  }
  return unique;
}
/** Missing or null tuple members release the corresponding unique reservation. */
function encodeUniqueTuple(data:Record<string,Json>,definition:CollectionDefinition,paths:readonly string[]):string|undefined {
  const parts:string[]=[];
  for (let j=0;j<paths.length;j++) { // NOSONAR -- own-slot scan avoids replaced array iterators
    const path=paths[j];
    if (!own(data,path) || data[path]===null) return undefined;
    const value=data[path];
    if (typeof value==='string' && !scalarString(value)) fail('SCHEMA_INVALID','Unique value contains a database-unsupported character');
    const field=props(definition.schema)[path];
    const tag=typeOf(field);
    let normalized:string;
    if (typeof value!=='string') normalized=canonical(value);
    else if (own(field,'format') && field.format==='date-time') normalized=utcInstant(value);
    else normalized=Reflect.apply(normalize,value,['NFC']) as string;
    append(parts,`${tag}:${Buffer.byteLength(normalized)}:${normalized}`);
  }
  const encodedValue=joined(parts,'');
  if (!withinBytes(encodedValue,MAX_INDEX_VALUE_BYTES)) fail('SCHEMA_INVALID','Unique value exceeds indexed byte limit');
  return encodedValue;
}

/** Derive one declared typed value for a bounded backfill batch. */
export function derivedIndexValue(data: Record<string,Json>, definition: CollectionDefinition, field:string): IndexValue {
  if (!own(data,field)) return {field,kind:'missing'};
  const value=data[field];
  if (value===null) return {field,kind:'null'};
  if (typeof value==='string') {
    if (!scalarString(value)) fail('SCHEMA_INVALID','Indexed value contains a database-unsupported character');
    const node=props(definition.schema)[field],instant=own(node,'format') && node.format==='date-time';
    const indexed=instant ? utcInstant(value) : value;
    if (!withinBytes(indexed,MAX_INDEX_VALUE_BYTES)) fail('SCHEMA_INVALID','Indexed value exceeds byte limit');
    return {field,kind:instant ? 'date-time' : 'string',value:indexed};
  }
  if (typeof value==='boolean') return {field,kind:'boolean',value};
  return {field,kind:'number',value:value as number};
}
