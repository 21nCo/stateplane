import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import YAML from 'yaml';

test('generated-client predicate shape matches the HTTP value-presence contract',async()=>{
  const source=await readFile(new URL('../contracts/openapi.yaml',import.meta.url),'utf8');
  const document=YAML.parse(source);
  const schema=document.components.schemas.Predicate;
  const validate=new Ajv({strict:false}).compile(schema);
  assert.equal(validate({field:'score',kind:'number',operator:'eq',value:2}),true);
  assert.equal(validate({field:'score',kind:'null',operator:'isNull'}),true);
  assert.equal(validate({field:'score',kind:'number',operator:'eq'}),false,
    'a generated client must reject a non-null predicate without value');
  assert.equal(validate({field:'score',kind:'null',operator:'isNull',value:null}),false,
    'a generated client must reject a value on isNull');
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
