import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { qualificationProviderQuery } from '../scripts/qualification-target.mjs';

const run = promisify(execFile);
const account = process.env.STATEPLANE_RAILWAY_ACCOUNT;

test('disposable readback query validates against the connected Railway schema', { skip: !account }, async () => {
  const unknown = '00000000-0000-4000-8000-000000000000';
  const payload = JSON.stringify({ query: qualificationProviderQuery,
    variables: { serviceId: unknown, environmentId: unknown, volumeInstanceId: unknown } });
  const { stdout } = await run('composio', ['proxy', 'https://backboard.railway.com/graphql/v2',
    '--toolkit', 'railway', '--account', account, '-X', 'POST', '-H', 'content-type: application/json', '-d', payload],
  { maxBuffer: 1024 * 1024 });
  const response = JSON.parse(stdout);
  assert.equal(response.errors?.some(error => error.extensions?.code === 'GRAPHQL_VALIDATION_FAILED') ?? false, false);
  assert.ok(response.data || response.errors?.length, 'Connected Railway did not evaluate the query');
});
