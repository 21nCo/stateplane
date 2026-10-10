import type { McpFnObjectSchema, McpFnToolDefinition } from '@mcpfn/core';
import { TransportFailure } from '@stateplane/application';
import type { StateplaneServices } from '@stateplane/application';
import type { VerifiedCredential } from '@stateplane/contracts';
import { serializeJson } from './json.js';
import { inputs } from './schemas.js';

type Args = Record<string, unknown>;
type ToolAnnotations = NonNullable<McpFnToolDefinition['annotations']>;
export type ToolName = keyof typeof inputs;
export interface StateplaneTool {
  name: ToolName; title: string; description: string; read: boolean;
  /** For a write: how to recover after COMMIT_OUTCOME_UNKNOWN. */
  recovery?: string;
  annotations: ToolAnnotations; inputSchema: McpFnObjectSchema;
  run(services: StateplaneServices, actor: VerifiedCredential, args: Args): Promise<Record<string, unknown>>;
}

/* HTTP body budgets from STA-8/9, applied to the re-encoded request. */
const recordBodyBytes = 1_048_576;
const queryBodyBytes = 32_768;
const batchBodyBytes = 3_145_728;
const encoder = new TextEncoder();

const invalid = (): never => { throw new TransportFailure('INVALID_ARGUMENT'); };
/** Accept only an ordinary parsed argument object. */
function plain(value: unknown): Args {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid();
  return value as Args;
}
/** Tools without a request body reject undeclared arguments before any service call. */
function only(args: Args, allowed: readonly string[]): void {
  for (const key of Reflect.ownKeys(args)) if (typeof key !== 'string' || !allowed.includes(key)) invalid();
}
/** A selector carries the HTTP path-segment rules; it never authorizes by itself. */
function selector(args: Args, name: string): string {
  const value = Object.hasOwn(args, name) ? args[name] : undefined;
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) return invalid();
  return value;
}
/** An explicitly supplied cursor must be a string; omission requests the first page. */
function cursor(args: Args): string | undefined {
  if (!Object.hasOwn(args, 'cursor')) return undefined;
  if (typeof args.cursor !== 'string') throw new TransportFailure('CURSOR_INVALID');
  return args.cursor;
}
function present(args: Args, name: string): unknown {
  if (!Object.hasOwn(args, name)) invalid();
  return args[name];
}
function serialized(value: unknown, limit: number): string {
  let text: string;
  try { text = serializeJson(value); } catch { return invalid(); }
  if (encoder.encode(text).byteLength > limit) throw new TransportFailure('RATE_LIMITED', false);
  return text;
}
/** Copy body fields as own data, including a literal "__proto__" name. */
function without(args: Args, omitted: readonly string[]): Args {
  return Object.fromEntries(Object.keys(args).filter(key => !omitted.includes(key)).map(key => [key, args[key]]));
}
function result(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TransportFailure('PROVIDER_UNAVAILABLE');
  return value as Record<string, unknown>;
}
/** HTTP returns NOT_FOUND for an absent live record. */
function found(value: unknown): Record<string, unknown> {
  if (!value) throw new TransportFailure('NOT_FOUND');
  return result(value);
}
const scope = (args: Args) => [selector(args, 'spaceId'), selector(args, 'collectionId')] as const;

const read: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const additive: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destructive: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/* Recovery after a write whose outcome is unknown. Only record mutations take
 * an idempotencyKey and replay a receipt. */
const recordRecovery = 'The write may have committed. Repeat the identical request with the same idempotencyKey and credential to recover its receipt.';
const defineRecovery = 'The definition may have committed. Read it with collections_get before defining again.';
const reviseRecovery = 'The revision may have committed. Read the collection with collections_get and compare its version and definition before revising again.';
const ingestRecovery = 'Items may have committed. Read batches_status, or repeat with the same operationKey and unchanged items to resume.';
const cancelRecovery = 'The cancellation may have committed. Read batches_status before cancelling again.';

function mutation(operation: 'create' | 'replace' | 'patch' | 'delete', title: string, description: string,
  annotations: ToolAnnotations): StateplaneTool {
  const name = `records_${operation}` as const;
  return { name, title, description, read: false, recovery: recordRecovery, annotations, inputSchema: inputs[name],
    run: async (services, actor, args) => {
      const [spaceId, collectionId] = scope(args);
      // The operation comes from the tool. Every other field reaches the
      // authority envelope, which authorizes before rejecting extra fields.
      if (Object.hasOwn(args, 'operation')) invalid();
      const envelope = { operation, ...without(args, ['spaceId', 'collectionId']) };
      return result(await services.records.mutate(actor, spaceId, collectionId, serialized(envelope, recordBodyBytes)));
    } };
}

export const tools: readonly StateplaneTool[] = [
  { name: 'spaces_list', title: 'List owned spaces', read: true, annotations: read, inputSchema: inputs.spaces_list,
    description: 'List spaces owned by the signed-in account, at most eight per page as {items,cursor}. Agent keys cannot list spaces; they receive a space ID from their owner. Pending provisioning can produce a short page with a cursor: continue until cursor is null.',
    run: async (services, actor, args) => { only(args, ['cursor']); return result(await services.spaces.list(actor, cursor(args))); } },
  { name: 'spaces_get', title: 'Get space metadata', read: true, annotations: read, inputSchema: inputs.spaces_get,
    description: 'Read one space\'s placement and lifecycle metadata. Requires ownership or a space:admin grant; it discloses no records.',
    run: async (services, actor, args) => { only(args, ['spaceId']); return result(await services.spaces.get(actor, selector(args, 'spaceId'))); } },
  { name: 'collections_list', title: 'List collections', read: true, annotations: read, inputSchema: inputs.collections_list,
    description: 'Discover collection definitions in a space that the credential can read, write or define, at most eight per page as {items,cursor}. Each item has the canonical definition and its version.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'cursor']);
      return result(await services.collections.list(actor, selector(args, 'spaceId'), undefined, cursor(args)));
    } },
  { name: 'collections_get', title: 'Get a collection definition', read: true, annotations: read, inputSchema: inputs.collections_get,
    description: 'Read the current definition, schema version and field readiness of one collection.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId']);
      return result(await services.collections.list(actor, ...scope(args)));
    } },
  { name: 'collections_define', title: 'Define a collection', read: false, recovery: defineRecovery, annotations: additive,
    inputSchema: inputs.collections_define,
    description: 'Create a collection at version 1 with a closed JSON Schema definition. Requires schema:write. An existing collection fails SCHEMA_CONFLICT. After COMMIT_OUTCOME_UNKNOWN, read it with collections_get before defining again.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId', 'definition']);
      const [spaceId, collectionId] = scope(args);
      return result(await services.collections.define(actor, spaceId, collectionId,
        serialized(present(args, 'definition'), recordBodyBytes)));
    } },
  { name: 'collections_revise', title: 'Revise a collection', read: false, recovery: reviseRecovery, annotations: additive,
    inputSchema: inputs.collections_revise,
    description: 'Apply a compatible additive revision at the next version. expectedVersion must equal the current version (SCHEMA_CONFLICT otherwise); breaking changes fail SCHEMA_BREAKING without changing records. After COMMIT_OUTCOME_UNKNOWN, read the collection with collections_get before revising again.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId', 'expectedVersion', 'definition']);
      const [spaceId, collectionId] = scope(args);
      const version = present(args, 'expectedVersion');
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) invalid();
      return result(await services.collections.revise(actor, spaceId, collectionId, version as number,
        serialized(present(args, 'definition'), recordBodyBytes)));
    } },
  { name: 'records_get', title: 'Get a record', read: true, annotations: read, inputSchema: inputs.records_get,
    description: 'Read one live record by canonical ID, including revision and schema version. A deleted or unknown ID fails NOT_FOUND.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId', 'id']);
      return found(await services.records.get(actor, ...scope(args), selector(args, 'id')));
    } },
  { name: 'records_get_by_key', title: 'Get a record by key', read: true, annotations: read, inputSchema: inputs.records_get_by_key,
    description: 'Resolve a live record by generated record ID or by normalized external key. Modes never fall back to each other.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId', 'mode', 'key']);
      const [spaceId, collectionId] = scope(args);
      const mode = present(args, 'mode');
      if (mode !== 'generated' && mode !== 'external') return invalid();
      return found(await services.records.byKey(actor, spaceId, collectionId, mode, selector(args, 'key')));
    } },
  { name: 'records_query', title: 'Query records', read: true, annotations: read, inputSchema: inputs.records_query,
    description: 'Return one exact live keyset page {records,nextCursor,schemaVersion} of up to 100 records. Pass nextCursor with the same predicates, sort and limit to continue. Pages are live, not a snapshot.',
    run: async (services, actor, args) => {
      const [spaceId, collectionId] = scope(args);
      return result(await services.records.query(actor, spaceId, collectionId,
        serialized(without(args, ['spaceId', 'collectionId']), queryBodyBytes)));
    } },
  { name: 'records_count', title: 'Count records', read: true, annotations: read, inputSchema: inputs.records_count,
    description: 'Return {count}, the exact number of live records matching the predicates at one statement snapshot.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId', 'predicates']);
      const [spaceId, collectionId] = scope(args);
      const count = await services.records.count(actor, spaceId, collectionId,
        serialized(present(args, 'predicates'), queryBodyBytes));
      if (typeof count !== 'number') throw new TransportFailure('PROVIDER_UNAVAILABLE');
      return { count };
    } },
  mutation('create', 'Create a record',
    'Create a new record and return its receipt. Create never updates an existing record: an external key held by a live or deleted record fails KEY_RESERVED, and a duplicate declared unique value fails UNIQUE_CONFLICT. Requires records:write.', additive),
  mutation('replace', 'Replace a record',
    'Replace all data of a record at expectedRevision; omitted optional fields are removed. A stale revision fails REVISION_CONFLICT. A retry with the same key and request returns the saved receipt.', destructive),
  mutation('patch', 'Patch a record',
    'Set or unset top-level fields of a record at expectedRevision, then validate the whole record. Overlapping set/unset paths fail INVALID_ARGUMENT.', destructive),
  mutation('delete', 'Delete a record',
    'Tombstone a record at expectedRevision. Its keys stay reserved. A retry with the same key and request returns the saved receipt.', destructive),
  { name: 'batches_ingest', title: 'Ingest a bounded batch', read: false, recovery: ingestRecovery, annotations: destructive,
    inputSchema: inputs.batches_ingest,
    description: 'Store an immutable manifest of 1–20 serialized record requests under operationKey and apply pending items. Items may replace or delete records. Resume with the same key and unchanged items; set retryFailed only to retry failed items.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId', 'operationKey', 'items', 'retryFailed']);
      const [spaceId, collectionId] = scope(args);
      const key = selector(args, 'operationKey');
      const retry = Object.hasOwn(args, 'retryFailed') ? args.retryFailed : false;
      if (typeof retry !== 'boolean') invalid();
      return result(await services.batches.ingest(actor, spaceId, collectionId, key,
        serialized(present(args, 'items'), batchBodyBytes), retry as boolean));
    } },
  { name: 'batches_status', title: 'Get batch status', read: true, annotations: read, inputSchema: inputs.batches_status,
    description: 'Read the durable progress of a batch, including each item\'s state and receipt. Use it to recover an interrupted ingestion.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId', 'operationKey']);
      return result(await services.batches.progress(actor, ...scope(args), selector(args, 'operationKey')));
    } },
  { name: 'batches_cancel', title: 'Cancel a batch', read: false, recovery: cancelRecovery, annotations: destructive,
    inputSchema: inputs.batches_cancel,
    description: 'Cancel the pending items of a batch. Committed items stay committed. After COMMIT_OUTCOME_UNKNOWN, read batches_status before cancelling again.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId', 'operationKey']);
      return result(await services.batches.cancel(actor, ...scope(args), selector(args, 'operationKey')));
    } },
  { name: 'events_list', title: 'List change events', read: true, annotations: read, inputSchema: inputs.events_list,
    description: 'Read up to 100 immutable change-event metadata entries after a cursor. Poll nextCursor even after a short or empty page. Requires events:read.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId', 'cursor']);
      return result(await services.events.list(actor, ...scope(args), cursor(args)));
    } },
  { name: 'projection_status', title: 'Get projection status', read: true, annotations: read, inputSchema: inputs.projection_status,
    description: 'Report the observed projection generation and state for one record. Exact reads never depend on projection state.',
    run: async (services, actor, args) => {
      only(args, ['spaceId', 'collectionId', 'id']);
      return result(await services.events.projection(actor, ...scope(args), selector(args, 'id')));
    } }
];

export { plain };
