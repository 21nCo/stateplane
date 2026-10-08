import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import YAML from 'yaml';

test('generated-client predicates agree with the typed HTTP query and count contract',async()=>{
  const source=await readFile(new URL('../contracts/openapi.yaml',import.meta.url),'utf8');
  const document=YAML.parse(source);
  const schema=document.components.schemas.Predicate;
  const validate=new Ajv({strict:false}).compile(schema);
  assert.equal(document.paths['/v1/spaces/{spaceId}/collections/{collectionId}/records/query'].post
    .requestBody.content['application/json'].schema.$ref,'#/components/schemas/RecordQuery');
  assert.equal(document.components.schemas.RecordQuery.properties.predicates.items.$ref,
    '#/components/schemas/Predicate');
  assert.equal(document.paths['/v1/spaces/{spaceId}/collections/{collectionId}/records/count'].post
    .requestBody.content['application/json'].schema.items.$ref,'#/components/schemas/Predicate');
  const accepted=[
    {field:'score',kind:'null',operator:'isNull'},
    ...[['string',''],['number',2],['boolean',false],['date-time','2024-02-29T23:59:59.123Z']]
      .flatMap(([kind,value])=>['eq','lt','lte','gt','gte'].map(operator=>({field:'score',kind,operator,value}))),
    ...[['string',['a','b']],['number',[1,2]],['boolean',[true,false]],
      ['date-time',['2016-12-31T23:59:60Z','2026-01-01T00:00:00Z']]]
      .map(([kind,value])=>({field:'score',kind,operator:'in',value})),
    {field:'score',kind:'number',operator:'in',value:Array(16).fill(1)},
    {field:'score',kind:'string',operator:'eq',value:'a'.repeat(512)},
    {field:'score',kind:'string',operator:'eq',value:'😀'},
    {field:'score',kind:'date-time',operator:'eq',value:'2000-02-29T00:00:00Z'}
  ];
  const rejected=[
    {field:'score',kind:'number',operator:'eq'},
    {field:'score',kind:'null',operator:'isNull',value:null},
    {field:'score',kind:'null',operator:'eq'},
    {field:'score',kind:'number',operator:'eq',value:'oops'},
    {field:'score',kind:'string',operator:'eq',value:3},
    {field:'score',kind:'boolean',operator:'eq',value:0},
    {field:'score',kind:'date-time',operator:'eq',value:'2026-13-01T00:00:00Z'},
    {field:'score',kind:'date-time',operator:'eq',value:'2026-02-30T00:00:00Z'},
    {field:'score',kind:'date-time',operator:'eq',value:'1900-02-29T00:00:00Z'},
    {field:'score',kind:'date-time',operator:'eq',value:'2026-12-31T23:59:60Z'},
    {field:'score',kind:'date-time',operator:'eq',value:'2026-01-01T00:00:00+00:00'},
    {field:'score',kind:'number',operator:'in',value:7},
    {field:'score',kind:'number',operator:'in',value:[]},
    {field:'score',kind:'number',operator:'in',value:Array(17).fill(1)},
    {field:'score',kind:'number',operator:'in',value:[1,'2']},
    {field:'score',kind:'string',operator:'in',value:[2]},
    {field:'score',kind:'boolean',operator:'in',value:[0]},
    {field:'score',kind:'date-time',operator:'in',value:['not-an-instant']},
    {field:'score',kind:'string',operator:'eq',value:'a'.repeat(513)},
    {field:'score',kind:'string',operator:'eq',value:'a\u0000b'},
    {field:'score',kind:'string',operator:'eq',value:'\uD800'},
    {field:'score',kind:'number',operator:'in',value:undefined}
  ];
  for (const predicate of accepted)
    assert.equal(validate(predicate),true,`valid ${JSON.stringify(predicate)}`);
  for (const predicate of rejected)
    assert.equal(validate(JSON.parse(JSON.stringify(predicate))),false,
      `invalid ${JSON.stringify(predicate)}`);
  for (const kind of ['string','date-time']) {
    const scalar=schema.oneOf.find(variant=>variant.properties.kind.const===kind &&
      Array.isArray(variant.properties.operator.enum));
    const list=schema.oneOf.find(variant=>variant.properties.kind.const===kind &&
      variant.properties.operator.const==='in');
    assert.equal(scalar.properties.value['x-utf8MaxBytes'],512);
    assert.equal(list.properties.value.items['x-utf8MaxBytes'],512);
  }
});

test('generated-client record mutations require the runtime operation envelope',async()=>{
  const source=await readFile(new URL('../contracts/openapi.yaml',import.meta.url),'utf8');
  const document=YAML.parse(source);
  const schema=document.components.schemas.RecordMutation;
  assert.equal(document.paths['/v1/spaces/{spaceId}/collections/{collectionId}/records'].post
    .requestBody.content['application/json'].schema.$ref,'#/components/schemas/RecordMutation');
  const validate=new Ajv({strict:false}).compile(schema);
  const valid={
    create:{operation:'create',idempotencyKey:'create-1',data:{label:'A'},externalKey:'a',expectedSchemaVersion:1},
    replace:{operation:'replace',idempotencyKey:'replace-1',id:'rec_1',expectedRevision:1,data:{label:'B'}},
    patch:{operation:'patch',idempotencyKey:'patch-1',id:'rec_1',expectedRevision:2,set:{label:'C'},unset:[]},
    delete:{operation:'delete',idempotencyKey:'delete-1',id:'rec_1',expectedRevision:3}
  };
  for (const [operation,envelope] of Object.entries(valid))
    assert.equal(validate(envelope),true,`${operation} must remain valid`);
  const invalid=[
    {operation:'create',idempotencyKey:'missing-data'},
    {...valid.create,id:'rec_1'},
    {...valid.replace,expectedRevision:undefined},
    {...valid.replace,externalKey:'a'},
    {...valid.patch,unset:undefined},
    {...valid.patch,data:{}},
    {...valid.delete,id:undefined},
    {...valid.delete,set:{}}
  ];
  for (const envelope of invalid) {
    const wire=JSON.parse(JSON.stringify(envelope));
    assert.equal(validate(wire),false,`${wire.operation} must reject ${JSON.stringify(wire)}`);
  }
});
