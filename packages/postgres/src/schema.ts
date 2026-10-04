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
const maxFields = 256;
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
  (!proxyDetector || !proxyDetector(value)) && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fail = (code: string, message?: string): never => { throw new AuthorityError(code,message); };

export function scalarString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  for (let i=0;i<value.length;i++) {
    const unit = Reflect.apply(codeUnit,value,[i]) as number;
    if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = Reflect.apply(codeUnit,value,[++i]) as number;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    }
  }
  return true;
}
export function plainJson(value: unknown, code = 'SCHEMA_INVALID', depth = 0, seen = new Set<object>(), trustedParsed = false): asserts value is Json {
  if ((!trustedParsed && (!proxyDetector || proxyDetector(value))) || depth > maxDepth) fail(code);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { if (!scalarString(value)) fail(code); return; }
  if (typeof value === 'number') { if (!isFiniteNumber(value)) fail(code); return; }
  if (!ordinary(value) && !Array.isArray(value)) fail(code);
  const object = value as object;
  if (setHas(seen,object)) fail(code);
  setAdd(seen,object);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length+1) fail(code);
    for (let i=0;i<value.length;i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value,i);
      if (!descriptor?.enumerable || !own(descriptor,'value')) fail(code);
      plainJson(descriptor!.value,code,depth+1,seen,trustedParsed);
    }
  } else {
    const keys=Reflect.ownKeys(object);
    for (let i=0;i<keys.length;i++) {
      const key=Object.getOwnPropertyDescriptor(keys,i)!.value as PropertyKey;
      const descriptor = Object.getOwnPropertyDescriptor(object,key);
      if (typeof key !== 'string' || !scalarString(key) || !descriptor?.enumerable || !own(descriptor,'value')) fail(code);
      plainJson(descriptor!.value,code,depth+1,seen,trustedParsed);
    }
  }
  setDelete(seen,object);
}
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
export function fingerprint(value: Json): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
const typeOf = (node: SchemaNode) => Array.isArray(node.type) ? (node.type[0]==='null' ? node.type[1] : node.type[0]) : node.type;
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
function validateNode(node: SchemaNode, root: boolean, depth: number, counter: { count: number }): void {
  if (!ordinary(node) || depth > maxDepth || ++counter.count > maxFields) fail('SCHEMA_UNSUPPORTED','Schema exceeds node/depth budget');
  node=Object.assign(Object.create(null),node) as SchemaNode;
  const nodeKeys=Object.keys(node);
  for (let i=0;i<nodeKeys.length;i++) {
    const key=Object.getOwnPropertyDescriptor(nodeKeys,i)!.value as string;
    if (!setHas(allowed,key)) fail('SCHEMA_UNSUPPORTED',`Unsupported keyword: ${key}`);
  }
  if (!own(node,'type') || (root ? !own(node,'$schema') || node.$schema !== 'https://json-schema.org/draft/2020-12/schema' : own(node,'$schema'))) fail('SCHEMA_UNSUPPORTED');
  const spec = node.type;
  let kind='';
  if (typeof spec === 'string' && setHas(typesAllowed,spec)) kind=spec;
  else if (Array.isArray(spec) && list(spec,'SCHEMA_UNSUPPORTED').length === 2 &&
    ((spec[1] === 'null' && includes(['string','integer','number','boolean'],spec[0])) ||
      (spec[0] === 'null' && includes(['string','integer','number','boolean'],spec[1])))) kind=spec[0]==='null' ? spec[1] : spec[0];
  else fail('SCHEMA_UNSUPPORTED','Unsupported type');
  if (root && kind !== 'object') fail('SCHEMA_UNSUPPORTED');
  if (own(node,'description') && (typeof node.description !== 'string' || !scalarString(node.description))) fail('SCHEMA_UNSUPPORTED');
  const sizeBounds=[['minLength','maxLength','string'],['minItems','maxItems','array']] as const;
  for (let i=0;i<sizeBounds.length;i++) {
    const bound=sizeBounds[i],min=bound[0],max=bound[1],expected=bound[2];
    if (own(node,min) || own(node,max)) {
      if (kind !== expected) fail('SCHEMA_UNSUPPORTED');
      if (own(node,min) && (!isIntegerNumber(node[min]) || (node[min] as number)<0)) fail('SCHEMA_UNSUPPORTED');
      if (own(node,max) && (!isIntegerNumber(node[max]) || (node[max] as number)<0)) fail('SCHEMA_UNSUPPORTED');
      if (own(node,min) && own(node,max) && (node[min] as number)>(node[max] as number)) fail('SCHEMA_UNSUPPORTED');
    }
  }
  if (own(node,'minimum') || own(node,'maximum')) {
    if (kind !== 'number' && kind !== 'integer') fail('SCHEMA_UNSUPPORTED');
    if (own(node,'minimum') && (typeof node.minimum !== 'number' || !isFiniteNumber(node.minimum))) fail('SCHEMA_UNSUPPORTED');
    if (own(node,'maximum') && (typeof node.maximum !== 'number' || !isFiniteNumber(node.maximum))) fail('SCHEMA_UNSUPPORTED');
    if (own(node,'minimum') && own(node,'maximum') && node.minimum!>node.maximum!) fail('SCHEMA_UNSUPPORTED');
  }
  if (own(node,'format') && (kind !== 'string' || node.format !== 'date-time')) fail('SCHEMA_UNSUPPORTED');
  if (kind === 'object') {
    if (!own(node,'additionalProperties') || node.additionalProperties !== false || own(node,'items') || own(node,'minItems') || own(node,'maxItems')) fail('SCHEMA_UNSUPPORTED');
    if (own(node,'properties') && !ordinary(node.properties)) fail('SCHEMA_UNSUPPORTED');
    const entries = Object.entries(props(node));
    for (let i=0;i<entries.length;i++) {
      const pair=Object.getOwnPropertyDescriptor(entries,i)!.value as [string,SchemaNode];
      const key=pair[0],child=pair[1];
      if (!scalarString(key)) fail('SCHEMA_UNSUPPORTED');
      validateNode(child,false,depth+1,counter);
    }
    if (own(node,'required')) {
      const required = list(node.required,'SCHEMA_UNSUPPORTED');
    if (!distinct(required) || any(required,key=>typeof key !== 'string' || !own(props(node),key))) fail('SCHEMA_UNSUPPORTED');
    }
  } else if (own(node,'properties') || own(node,'required') || own(node,'additionalProperties')) fail('SCHEMA_UNSUPPORTED');
  if (kind === 'array') { if (!own(node,'items')) fail('SCHEMA_UNSUPPORTED'); validateNode(node.items!,false,depth+1,counter); }
  else if (own(node,'items') || own(node,'minItems') || own(node,'maxItems')) fail('SCHEMA_UNSUPPORTED');
  if (own(node,'enum')) {
    const members = list(node.enum,'SCHEMA_UNSUPPORTED');
    if (!members.length) fail('SCHEMA_UNSUPPORTED');
    const canonicalMembers:string[]=[];
    for (let i=0;i<members.length;i++) append(canonicalMembers,canonical(members[i] as Json));
    if (!distinct(canonicalMembers)) fail('SCHEMA_UNSUPPORTED');
    for (let i=0;i<members.length;i++) {
      const member=Object.getOwnPropertyDescriptor(members,i)!.value;
      try { validateValue(member as Json,{...node,enum:undefined},depth); }
      catch { fail('SCHEMA_UNSUPPORTED','Invalid enum member'); }
    }
  }
}
const leapDays = new Set(['1972-06-30','1972-12-31','1973-12-31','1974-12-31','1975-12-31','1976-12-31','1977-12-31','1978-12-31','1979-12-31','1981-06-30','1982-06-30','1983-06-30','1985-06-30','1987-12-31','1989-12-31','1990-12-31','1992-06-30','1993-06-30','1994-06-30','1995-12-31','1997-06-30','1998-12-31','2005-12-31','2008-12-31','2012-06-30','2015-06-30','2016-12-31']);
export function utcInstant(value: string): string {
  const match=Reflect.apply(nativeRegexExec,/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/,[value]) as RegExpExecArray | null;
  if (!match || Reflect.apply(startsWith,match[1],['0000-'])) fail('SCHEMA_INVALID');
  const checkedMatch=match!;
  const leap=Reflect.apply(endsWith,checkedMatch[1],['T23:59:60']) as boolean;
  if (Reflect.apply(endsWith,checkedMatch[1],[':60']) &&
    (!leap || !setHas(leapDays,Reflect.apply(slice,checkedMatch[1],[0,10]) as string))) fail('SCHEMA_INVALID');
  const checked=leap ? `${Reflect.apply(slice,checkedMatch[1],[0,-2])}59` : checkedMatch[1];
  const instant=new NativeDate(`${checked}Z`);
  if (!Number.isFinite(Reflect.apply(nativeGetTime,instant,[])) ||
    (Reflect.apply(slice,Reflect.apply(nativeISOString,instant,[]) as string,[0,19]) as string)!==checked) fail('SCHEMA_INVALID');
  let fraction=checkedMatch[2]??'';
  while (fraction.length && Reflect.apply(codeUnit,fraction,[fraction.length-1])===48)
    fraction=Reflect.apply(slice,fraction,[0,-1]) as string;
  return `${checkedMatch[1]}${fraction ? `.${fraction}` : ''}Z`;
}
export function validateValue(value: Json, node: SchemaNode, depth=0): void {
  if (depth > maxDepth) fail('SCHEMA_INVALID');
  node=Object.assign(Object.create(null),node) as SchemaNode;
  const kind=typeOf(node);
  if (value === null) { if (!nullable(node)) fail('SCHEMA_INVALID'); }
  else if (kind==='object') {
    if (!ordinary(value)) fail('SCHEMA_INVALID');
    const entries=Object.entries(value as Record<string,Json>);
    for (let i=0;i<entries.length;i++) {
      const pair=Object.getOwnPropertyDescriptor(entries,i)!.value as [string,Json];
      const key=pair[0],item=pair[1];
      if (!own(props(node),key)) fail('SCHEMA_INVALID');
      validateValue(item,props(node)[key],depth+1);
    }
    const required=node.required??[];
    for (let i=0;i<required.length;i++) if (!own(value as object,Object.getOwnPropertyDescriptor(required,i)!.value)) fail('SCHEMA_INVALID');
  } else if (kind==='array') {
    if (!Array.isArray(value) || (node.minItems!==undefined && value.length<node.minItems) || (node.maxItems!==undefined && value.length>node.maxItems)) fail('SCHEMA_INVALID');
    const members=value as Json[];
    for (let i=0;i<members.length;i++) validateValue(members[i],node.items!,depth+1);
  } else if (kind==='string') {
    if (typeof value!=='string' || !scalarString(value)) fail('SCHEMA_INVALID');
    const length=scalarLength(value as string);
    if ((node.minLength!==undefined && length<node.minLength) || (node.maxLength!==undefined && length>node.maxLength)) fail('SCHEMA_INVALID');
    if (node.format==='date-time') utcInstant(value as string);
  } else if (kind==='boolean') { if (typeof value!=='boolean') fail('SCHEMA_INVALID'); }
  else {
    if (typeof value!=='number' || !isFiniteNumber(value) || (kind==='integer' && !isSafeInteger(value)) ||
      (node.minimum!==undefined && value<node.minimum) || (node.maximum!==undefined && value>node.maximum)) fail('SCHEMA_INVALID');
  }
  if (node.enum && !any(node.enum,member=>canonical(member)===canonical(value))) fail('SCHEMA_INVALID');
}
const scalarField = (schema: SchemaNode, path: unknown): path is string => typeof path==='string' && path.length>0 && scalarString(path) &&
  own(props(schema),path) && includes(['string','number','integer','boolean'],typeOf(props(schema)[path]));
export function validateDefinition(input: unknown, trustedParsed = false): CollectionDefinition {
  plainJson(input,'SCHEMA_UNSUPPORTED',0,new Set<object>(),trustedParsed);
  if (!ordinary(input) || any(Object.keys(input),key=>!includes(['slug','version','schema','unique','filterable','sortable','lifecycle'],key))) fail('SCHEMA_UNSUPPORTED');
  const definition=input as unknown as CollectionDefinition;
  if (!own(definition,'slug') || !own(definition,'version') || !own(definition,'schema')) fail('SCHEMA_UNSUPPORTED');
  if (!scalarString(definition.slug) || !definition.slug || !isSafeInteger(definition.version) || definition.version<1) fail('SCHEMA_UNSUPPORTED');
  validateNode(definition.schema,true,0,{count:0});
  if (!own(definition,'unique') || !own(definition,'filterable') || !own(definition,'sortable')) fail('SCHEMA_UNSUPPORTED');
  const uniques=list(definition.unique,'SCHEMA_UNSUPPORTED');
  const names:string[]=[];
  for (let i=0;i<uniques.length;i++) {
    const entry=Object.getOwnPropertyDescriptor(uniques,i)!.value;
    if (!ordinary(entry) || Reflect.ownKeys(entry).length!==2 || !own(entry,'name') || !own(entry,'paths')) fail('SCHEMA_UNSUPPORTED');
    const item=entry as {name:unknown;paths:unknown};
    const paths=list(item.paths,'SCHEMA_UNSUPPORTED');
    if (!scalarString(item.name) || !item.name || includes(names,item.name) || !paths.length || !distinct(paths) || any(paths,path=>!scalarField(definition.schema,path))) fail('SCHEMA_UNSUPPORTED');
    append(names,item.name as string);
  }
  const declarations=['filterable','sortable'] as const;
  for (let i=0;i<declarations.length;i++) {
    const key=declarations[i];
    const paths=list(definition[key],'SCHEMA_UNSUPPORTED');
    if (!distinct(paths) || any(paths,path=>!scalarField(definition.schema,path))) fail('SCHEMA_UNSUPPORTED');
  }
  if (own(definition,'lifecycle')) {
    const rule=definition.lifecycle;
    if (!ordinary(rule) || joined(sorted(Object.keys(rule),compare),',')!=='field,initial,transitions' || !scalarField(definition.schema,rule.field) ||
      typeOf(props(definition.schema)[rule.field])!=='string' || nullable(props(definition.schema)[rule.field]) || !ordinary(rule.transitions) ||
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
  const encoded=canonical(definition as unknown as Json);
  if (Buffer.byteLength(encoded)>maxBytes) fail('SCHEMA_UNSUPPORTED','Definition exceeds byte budget');
  return JSON.parse(encoded) as CollectionDefinition;
}
function withoutAnnotations(node: SchemaNode): Json {
  const clone:Record<string,Json>=Object.create(null);
  const keys=Object.keys(node) as Array<keyof SchemaNode>;
  for (let i=0;i<keys.length;i++) {
    const key=keys[i];
    if (key==='description') continue;
    if (key==='properties') {
      const children:Record<string,Json>=Object.create(null);
      const names=Object.keys(props(node));
      for (let j=0;j<names.length;j++) {
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
export function compatible(old: CollectionDefinition, next: CollectionDefinition): void {
  if (old.slug!==next.slug || next.version!==old.version+1 || canonical(old.unique as unknown as Json)!==canonical(next.unique as unknown as Json) ||
    canonical((own(old,'lifecycle') ? old.lifecycle! : null) as Json)!==canonical((own(next,'lifecycle') ? next.lifecycle! : null) as Json)) fail('SCHEMA_BREAKING','Slug, uniqueness or lifecycle change requires migration');
  const oldProps=props(old.schema), nextProps=props(next.schema);
  const names=Object.keys(oldProps);
  for (let i=0;i<names.length;i++) {
    const name=names[i],oldNode=oldProps[name];
    if (!own(nextProps,name) || canonical(withoutAnnotations(oldNode))!==canonical(withoutAnnotations(nextProps[name]))) fail('SCHEMA_BREAKING',`Existing field ${name} changed`);
  }
  const a={...old.schema,properties:{}} as SchemaNode,b={...next.schema,properties:{}} as SchemaNode;
  if (canonical(withoutAnnotations(a))!==canonical(withoutAnnotations(b))) fail('SCHEMA_BREAKING','Root constraints changed');
  const nextNames=Object.keys(nextProps);
  for (let i=0;i<nextNames.length;i++) {
    const name=nextNames[i];
    if (!own(oldProps,name) && includes(next.schema.required??[],name)) fail('SCHEMA_BREAKING',`New field ${name} must be optional`);
  }
  const compatibleDeclarations=['filterable','sortable'] as const;
  for (let i=0;i<compatibleDeclarations.length;i++) {
    const key=compatibleDeclarations[i];
    if (any(old[key],name=>!includes(next[key],name))) fail('SCHEMA_BREAKING',`${key} cannot be removed`);
  }
}
const whites = new Set([0x20,0x85,0xa0,0x1680,0x2028,0x2029,0x202f,0x205f,0x3000]);
for (let i=9;i<=13;i++) whites.add(i);
for (let i=0x2000;i<=0x200a;i++) whites.add(i);
export function externalKey(value: unknown): string {
  if (!scalarString(value)) fail('INVALID_ARGUMENT');
  const n=Reflect.apply(normalize,value,['NFC']) as string;
  let start=0,end=n.length;
  while (start<end && setHas(whites,Reflect.apply(codeUnit,n,[start]) as number)) start++;
  while (end>start && setHas(whites,Reflect.apply(codeUnit,n,[end-1]) as number)) end--;
  const result=Reflect.apply(slice,n,[start,end]) as string;
  if (!result) fail('INVALID_ARGUMENT');
  return result;
}
export function derivedValues(data: Record<string,Json>, definition: CollectionDefinition): {unique: UniqueValue[]; indexes: IndexValue[]} {
  const unique: UniqueValue[]=[]; const indexes: IndexValue[]=[];
  for (let i=0;i<definition.unique.length;i++) {
    const item=definition.unique[i];
    const parts: string[]=[]; let skip=false;
    for (let j=0;j<item.paths.length;j++) {
      const path=item.paths[j];
      const value=data[path];
      if (!own(data,path) || value===null) { skip=true; break; }
      const field=props(definition.schema)[path];
      const tag=typeOf(field); const normalized=typeof value==='string' ?
        (own(field,'format') && field.format==='date-time' ? utcInstant(value) : Reflect.apply(normalize,value,['NFC']) as string) : canonical(value);
      append(parts,`${tag}:${Buffer.byteLength(normalized)}:${normalized}`);
    }
    if (!skip) append(unique,{name:item.name,encodedValue:joined(parts,'')});
  }
  const fields:string[]=[];
  const pathLists=[definition.filterable,definition.sortable];
  for (let j=0;j<pathLists.length;j++) {
    const paths=pathLists[j];
    for (let i=0;i<paths.length;i++) if (!includes(fields,paths[i])) append(fields,paths[i]);
  }
  for (let i=0;i<fields.length;i++) {
    const field=fields[i];
    if (!own(data,field)) continue;
    const value=data[field];
    if (value===null) append(indexes,{field,kind:'null'});
    else if (typeof value==='string') {
      const node=props(definition.schema)[field],instant=own(node,'format') && node.format==='date-time';
      append(indexes,{field,kind:instant ? 'date-time' : 'string',value:instant ? utcInstant(value) : value});
    }
    else if (typeof value==='boolean') append(indexes,{field,kind:'boolean',value});
    else append(indexes,{field,kind:'number',value:value as number});
  }
  return {unique,indexes};
}
