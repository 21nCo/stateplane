import pg from 'pg';
import { parseArgs } from 'node:util';
import { connectionOptions } from './db-connection.mjs';
import { PostgresAuthority, PostgresOutbox } from '../packages/postgres/dist/index.js';

// Product-internal operator access to one cell's outbox. Status is read-only;
// retry, reconcile and cancel are audited under STATEPLANE_OPERATOR.
const usage = `Usage: node scripts/outbox.mjs status [spaceId] [--after-space <spaceId> --after-collection <collectionId>]
       node scripts/outbox.mjs job <jobId>
       node scripts/outbox.mjs retry <spaceId> [collectionId] --reason <text>
       node scripts/outbox.mjs reconcile <spaceId> <collectionId> --reason <text>
       node scripts/outbox.mjs cancel <jobId> --reason <text>`;
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  reason: { type: 'string' }, 'after-space': { type: 'string' }, 'after-collection': { type: 'string' } } });
const [command, ...rest] = positionals;
const operator = process.env.STATEPLANE_OPERATOR;
const mutating = ['retry', 'reconcile', 'cancel'].includes(command);
const arity = { status: [0, 1], job: [1, 1], retry: [1, 2], reconcile: [2, 2], cancel: [1, 1] }[command];
// A status page's `next` cursor is passed back as both --after options.
const cursor = values['after-space'] !== undefined || values['after-collection'] !== undefined;
if (!arity || rest.length < arity[0] || rest.length > arity[1] || (mutating && (!values.reason || !operator))
  || (cursor && (command !== 'status' || values['after-space'] === undefined || values['after-collection'] === undefined))) {
  process.stderr.write(`${usage}\nMutations require --reason and STATEPLANE_OPERATOR. Status continues from a page's next cursor.\n`);
  process.exit(2);
}
const pool = new pg.Pool({ ...connectionOptions(process.env.DATABASE_URL), max: 1 });
try {
  const outbox = new PostgresOutbox(pool, new PostgresAuthority(pool, 1));
  let result;
  if (command === 'status') result = await outbox.status(rest[0],
    cursor ? { spaceId: values['after-space'], collectionId: values['after-collection'] } : undefined);
  else if (command === 'job') result = await outbox.reconciliation(rest[0]);
  else if (command === 'retry') result = { retried: await outbox.retry(operator, rest[0], rest[1] ?? null, values.reason) };
  else if (command === 'reconcile') result = await outbox.reconcile(operator, rest[0], rest[1], values.reason);
  else result = await outbox.cancel(operator, rest[0], values.reason);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (typeof error?.code !== 'string' || !/^[A-Z_]+$/.test(error.code)) throw error;
  process.stderr.write(`${JSON.stringify({ error: { code: error.code } })}\n`);
  process.exitCode = 1;
} finally { await pool.end(); }
