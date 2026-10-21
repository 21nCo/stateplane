/** Browser-safe views of v1 API responses rendered by the UI. */
export interface Space {
  spaceId:string; ownerPrincipalId:string; homeCellId:string; cellId:string; storageTargetId:string;
  lifecycle:string; policyVersion:number; placementGeneration:number; createdAt:string; updatedAt:string;
}
export interface SchemaNode { type:string|string[]; format?:string; properties?:Record<string,SchemaNode>; enum?:unknown[]; required?:string[] }
export interface Definition {
  slug:string; version:number; schema:SchemaNode; unique:{name:string;paths:string[]}[];
  filterable:string[]; sortable:string[]; lifecycle?:{field:string;initial:string[];transitions:Record<string,string[]>};
}
export interface Collection { definition:Definition; ready:string[]; pending:string[] }
export interface StoredRecord {
  ref:{id:string}; revision:number; schemaVersion:number; canonicalData:string;
  keyMode:'generated'|'external'; normalizedKey:string; tombstone:boolean;
}
export interface Receipt {
  receiptId:string; ref:{id:string}; operation:string; beforeRevision:number|null; revision:number;
  schemaVersion:number; committedAt:string; projection:{state:string;generation:number}; replayed:boolean;
}
export interface Page<T> { items:T[]; cursor:string|null }
