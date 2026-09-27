import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, chmod } from 'node:fs/promises';
import { selectRdsRoot } from './rds-ca.mjs';

const run = promisify(execFile);
const [region, instanceId, output] = process.argv.slice(2);
if (!/^(ap-south-1|us-east-1|eu-west-1)$/.test(region ?? '') || !/^[a-z0-9-]+$/.test(instanceId ?? '') || !output) {
  console.error('Usage: node scripts/select-rds-ca.mjs <region> <rds-instance-id> <private-single-root.pem>');
  process.exit(2);
}
const { stdout } = await run('aws', ['rds', 'describe-db-instances', '--region', region, '--db-instance-identifier', instanceId, '--output', 'json']);
const instance = JSON.parse(stdout).DBInstances?.[0];
if (instance?.DBInstanceIdentifier !== instanceId || instance.Engine !== 'postgres') throw new Error('RDS instance identity mismatch');
const response = await fetch(`https://truststore.pki.rds.amazonaws.com/${region}/${region}-bundle.pem`);
if (!response.ok) throw new Error('Regional RDS CA bundle unavailable');
const root = selectRdsRoot(await response.text(), region, instance.CACertificateIdentifier);
await writeFile(output, root.pem, { mode: 0o600 });
await chmod(output, 0o600);
console.log(`Selected ${instance.CACertificateIdentifier} for ${region}/${instanceId}; SHA-256 ${root.fingerprint256}`);
