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
