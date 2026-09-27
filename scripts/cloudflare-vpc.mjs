import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const accountIdPattern = /^[a-f0-9]{32}$/i;

export function parseVpcServiceResponse(body, serviceId) {
  if (body?.success !== true || !body.result || typeof body.result !== 'object') {
    throw new Error('Cloudflare VPC service API returned an unsuccessful or empty result');
  }
  if (body.result.service_id !== serviceId) throw new Error('Cloudflare VPC service ID mismatch');
  return body.result;
}

export async function createVpcServiceReader(wrangler, { run = exec, request = fetch, accountId = process.env.CLOUDFLARE_ACCOUNT_ID } = {}) {
  const options = { maxBuffer: 1024 * 1024 };
  const { stdout: whoamiOutput } = await run(wrangler, ['whoami', '--json'], options);
  const whoami = JSON.parse(whoamiOutput);
  if (whoami.loggedIn !== true || !Array.isArray(whoami.accounts)) throw new Error('Wrangler is not authenticated');
  const accounts = whoami.accounts.filter(account => accountIdPattern.test(account.id));
  const selected = accountId ?? (accounts.length === 1 ? accounts[0].id : undefined);
  if (!selected || !accounts.some(account => account.id === selected)) throw new Error('Set CLOUDFLARE_ACCOUNT_ID to an authenticated Wrangler account');

  const { stdout: tokenOutput } = await run(wrangler, ['auth', 'token', '--json'], options);
  const token = JSON.parse(tokenOutput).token;
  if (typeof token !== 'string' || !token) throw new Error('Wrangler returned no authentication token');

  return async serviceId => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${selected}/connectivity/directory/services/${serviceId}`;
    const response = await request(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Cloudflare VPC service API returned HTTP ${response.status}`);
    return parseVpcServiceResponse(await response.json(), serviceId);
  };
}
