import type { Definition, SchemaNode } from './types';

export const operators=['eq','lt','lte','gt','gte','in','isNull'] as const;
export interface FilterRow { field:string; op:string; value:string }
type Kind='string'|'number'|'boolean'|'date-time';
// The v1 query limits: predicates per query, values per "in", and UTF-8 bytes per text value.
export const maxPredicates=16;
const maxIn=16, maxBytes=512, maxBody=32_768, maxSearch=12_288, maxCursor=4_096;
// Days with an announced leap second; the authority accepts 23:59:60 UTC only on these.
const leapDays=new Set(['1972-06-30','1972-12-31','1973-12-31','1974-12-31','1975-12-31','1976-12-31','1977-12-31','1978-12-31','1979-12-31','1981-06-30','1982-06-30','1983-06-30','1985-06-30','1987-12-31','1989-12-31','1990-12-31','1992-06-30','1993-06-30','1994-06-30','1995-12-31','1997-06-30','1998-12-31','2005-12-31','2008-12-31','2012-06-30','2015-06-30','2016-12-31']);

/** The typed index kind the authority derives for a declared top-level field. */
export function fieldKind(definition:Definition,field:string):Kind|null {
  const node:SchemaNode|undefined=definition.schema.properties?.[field];
  if (!node) return null;
  const type=Array.isArray(node.type) ? node.type.find(item=>item!=='null') : node.type;
  if (node.format==='date-time') return 'date-time';
  if (type==='integer' || type==='number') return 'number';
  return type==='boolean' || type==='string' ? type : null;
}

/** Why the authority would refuse a filter or sort on this field: it must be declared
 * for that use and its index ready. Null when it can be used. */
function unusable(definition:Definition,ready:readonly string[],field:string,use:'filterable'|'sortable'):string|null {
  if (!fieldKind(definition,field)) return 'Choose a declared field.';
  if (!definition[use].includes(field)) return `This field is not ${use}.`;
  return ready.includes(field) ? null : 'Its index is still being built. Build it on the schema page first.';
}
export const sortProblem=(definition:Definition,ready:readonly string[],field:string)=>unusable(definition,ready,field,'sortable');

/** A real UTC calendar instant; 23:59:60 only on a leap-second day. */
function instant(text:string):boolean {
  const match=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?Z$/.exec(text);
  if (!match || match[1].startsWith('0000-')) return false;
  const leap=match[1].endsWith('T23:59:60');
  if (leap && !leapDays.has(match[1].slice(0,10))) return false;
  const clock=leap ? `${match[1].slice(0,-2)}59` : match[1];
  const date=new Date(`${clock}Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,19)===clock;
}
const fits=(text:string)=>new TextEncoder().encode(text).length<=maxBytes;
function scalar(kind:Kind,raw:string):string|number|boolean|undefined {
  const text=raw.trim();
  // JSON decimal syntax only: Number() would also read 0x10 or 0b11 as a different value.
  if (kind==='number') { const value=Number(text); return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(value) ? value : undefined; }
  if (kind==='boolean') return text==='true' ? true : text==='false' ? false : undefined;
  if (kind==='date-time') return instant(text) && fits(text) ? text : undefined;
  return fits(raw) ? raw : undefined;
}

/** Convert form rows to typed v1 predicates; return a message for each row the user must fix.
 * A row the authority would refuse (an undeclared, unfilterable or unbuilt field, a value
 * past a limit or containing U+0000, more than 16 "in" values, or a 17th predicate) is reported here, so no request is sent. */
export function predicates(definition:Definition,rows:readonly FilterRow[],ready:readonly string[]):{predicates:unknown[];errors:Record<number,string>} {
  const result:unknown[]=[];
  const errors:Record<number,string>={};
  rows.forEach((row,index)=>{
    if (index>=maxPredicates) { errors[index]=`At most ${maxPredicates} filters apply. Remove this one.`; return; }
    const refused=unusable(definition,ready,row.field,'filterable');
    if (refused) { errors[index]=refused; return; }
    const kind=fieldKind(definition,row.field)!;
    if (row.op==='isNull') { result.push({field:row.field,kind:'null',operator:'isNull'}); return; }
    if (!operators.includes(row.op as typeof operators[number])) { errors[index]='Choose an operator.'; return; }
    const raw=row.op==='in' ? row.value.split(',') : [row.value];
    // The authority refuses U+0000 in any text value; an instant can never contain it.
    if (kind==='string' && raw.some(item=>item.includes('\0'))) { errors[index]='Remove the NUL (U+0000) character; a text value cannot contain it.'; return; }
    if (raw.length>maxIn) { errors[index]=`Enter at most ${maxIn} comma-separated values.`; return; }
    const values=raw.map(item=>scalar(kind,item));
    if (values.some(item=>item===undefined)) {
      errors[index]=kind==='date-time' ? 'Enter a UTC instant such as 2026-01-31T12:00:00Z.' :
        kind==='number' ? 'Enter a number.' : kind==='boolean' ? 'Enter true or false.' :
        `Enter ${row.op==='in' ? 'values' : 'a value'} of at most ${maxBytes} bytes each.`;
      return;
    }
    result.push({field:row.field,kind,operator:row.op,value:row.op==='in' ? values : values[0]});
  });
  return {predicates:result,errors};
}

/** The query body as sent; the authority refuses it or its count body past 32,768 UTF-8 bytes of JSON. */
export function queryBody(predicates:unknown[],limit:number,sort?:{field:string;direction:string},cursor?:string) {
  const body={predicates,limit,...(sort ? {sort} : {}),...(cursor!==undefined ? {cursor} : {})};
  return {body,error:[body,predicates].some(item=>new TextEncoder().encode(JSON.stringify(item)).length>maxBody) ? `These filters are too large to send (over ${maxBody} bytes). Remove filters or shorten values.` : null};
}

/** Node and Cloudflare refuse a URL past 16 KiB before any route runs. A records query string, with the longest cursor
 * the authority issues and count=1, stays within 12,288 bytes, leaving the rest for the path and headers, so every link the page makes can be followed. */
export const searchProblem=(query:string)=>query.length+`&cursor=${'x'.repeat(maxCursor)}&count=1`.length>maxSearch ? `These filters are too long for a page address (over ${maxSearch} bytes once encoded). Remove filters or shorten values.` : null;
