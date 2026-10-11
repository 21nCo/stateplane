import type { Definition, SchemaNode } from './types';

export const operators=['eq','lt','lte','gt','gte','in','isNull'] as const;
export interface FilterRow { field:string; op:string; value:string }
type Kind='string'|'number'|'boolean'|'date-time';
const maxIn=16;

/** The typed index kind the authority derives for a declared top-level field. */
export function fieldKind(definition:Definition,field:string):Kind|null {
  const node:SchemaNode|undefined=definition.schema.properties?.[field];
  if (!node) return null;
  const type=Array.isArray(node.type) ? node.type.find(item=>item!=='null') : node.type;
  if (node.format==='date-time') return 'date-time';
  if (type==='integer' || type==='number') return 'number';
  return type==='boolean' || type==='string' ? type : null;
}

function scalar(kind:Kind,raw:string):string|number|boolean|undefined {
  const text=raw.trim();
  if (kind==='number') { const value=Number(text); return text && Number.isFinite(value) ? value : undefined; }
  if (kind==='boolean') return text==='true' ? true : text==='false' ? false : undefined;
  if (kind==='date-time') return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(text) ? text : undefined;
  return raw;
}

/** Convert form rows to typed v1 predicates; return a message for each row the user must fix. */
export function predicates(definition:Definition,rows:readonly FilterRow[]):{predicates:unknown[];errors:Record<number,string>} {
  const result:unknown[]=[];
  const errors:Record<number,string>={};
  rows.forEach((row,index)=>{
    const kind=fieldKind(definition,row.field);
    if (!kind) { errors[index]='Choose a declared field.'; return; }
    if (row.op==='isNull') { result.push({field:row.field,kind:'null',operator:'isNull'}); return; }
    if (!operators.includes(row.op as typeof operators[number])) { errors[index]='Choose an operator.'; return; }
    const raw=row.op==='in' ? row.value.split(',') : [row.value];
    const values=raw.map(item=>scalar(kind,item));
    if (!values.length || values.length>maxIn || values.some(item=>item===undefined)) {
      errors[index]=kind==='date-time' ? 'Enter a UTC instant such as 2026-01-31T12:00:00Z.' :
        kind==='number' ? 'Enter a number.' : kind==='boolean' ? 'Enter true or false.' :
        `Enter a value${row.op==='in' ? ` list of at most ${maxIn} comma-separated items` : ''}.`;
      return;
    }
    result.push({field:row.field,kind,operator:row.op,value:row.op==='in' ? values : values[0]});
  });
  return {predicates:result,errors};
}
