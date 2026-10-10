import { defineMcpFnServer } from '@mcpfn/core';
import type { McpFnRequestExtra, McpFnSchemaIssue, McpFnServerDeclaration } from '@mcpfn/core';
import { createAuthProviderMcpHandler, createProtectedResourceMetadata, protectedResourceMetadataUrl } from '@mcpfn/auth';
import { TransportFailure, classifyError } from '@stateplane/application';
import type { StateplaneServices } from '@stateplane/application';
import type { IdentityVerifier } from '@stateplane/auth';
import type { VerifiedCredential } from '@stateplane/contracts';
import { guidance, guidanceUri, instructions } from './guidance.js';
import { plain, tools } from './tools.js';
import type { StateplaneTool } from './tools.js';

export interface McpContext { services: StateplaneServices; credential: VerifiedCredential | null }
type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };

export const serverInfo = { name: 'stateplane', version: '0.1.0' } as const;
/** The JSON-RPC body bound: the 3 MiB batch envelope plus protocol framing. */
export const maxRequestBytes = 4_194_304;
const byName = new Map(tools.map(tool => [tool.name as string, tool]));

const messages: Record<string, string> = {
  INVALID_ARGUMENT: 'The arguments do not match this tool or operation. Correct them before calling again.',
  SCHEMA_INVALID: 'The record data does not satisfy the current collection schema. Read the collection definition and correct the data.',
  SCHEMA_UNSUPPORTED: 'The collection definition uses an unsupported or malformed JSON Schema construct.',
  SCHEMA_BREAKING: 'The revision is not a compatible additive change.',
  SCHEMA_CONFLICT: 'The collection version, existence or field readiness does not match. Read the collection definition before retrying.',
  CURSOR_INVALID: 'The cursor is malformed, expired, or bound to another query or credential. Restart from the first page.',
  UNAUTHENTICATED: 'The credential is missing, expired or revoked.',
  FORBIDDEN: 'The credential lacks the capability required for this operation.',
  NOT_FOUND: 'The space, collection or record does not exist or is not visible to this credential.',
  SPACE_UNAVAILABLE: 'The space lifecycle does not allow this operation.',
  REVISION_CONFLICT: 'The record changed. Read it again and decide before writing with its current revision.',
  UNIQUE_CONFLICT: 'A live record already holds this key or unique value.',
  KEY_RESERVED: 'Another live or deleted record holds this key; keys are never reused.',
  LINK_RESTRICTED: 'A restricting link prevents this deletion.',
  IDEMPOTENCY_MISMATCH: 'This idempotency key was used for a different request. Repeat the original request exactly or use a new key for a new request.',
  BATCH_CONFLICT: 'This operation key belongs to a different manifest. Resubmit the original items or use a new key.',
  BATCH_CANCELLED: 'The batch was cancelled.',
  RECEIPT_EXPIRED: 'The receipt expired before commit. Read the current state before writing again.',
  RECEIPT_PENDING: 'The same request is still committing. Repeat the identical request shortly.',
  PROVIDER_UNAVAILABLE: 'A storage or identity provider is unavailable.',
  BACKPRESSURE: 'The service is busy.',
  RATE_LIMITED: 'The request exceeds a time, capacity or size limit.',
  COMMIT_OUTCOME_UNKNOWN: 'The write may have committed. Repeat the identical request with the same idempotency key and credential to recover its receipt.',
  STALE_PLACEMENT: 'The space placement or policy changed during the request.'
};
const validationCodes = new Set(['INVALID_ARGUMENT', 'SCHEMA_INVALID', 'SCHEMA_UNSUPPORTED']);

function toolResult(value: Record<string, unknown>, isError: boolean): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError } : {}) };
}
/** Stable envelope without provider messages, credentials or argument values.
 * Schema issues name only static input locations from the tool schema. */
function failure(error: unknown, read: boolean, issues?: readonly McpFnSchemaIssue[]): ToolResult {
  const { code, retryable } = classifyError(error, read);
  const detail = issues?.length && validationCodes.has(code) ? { issues: issues.map(issue => ({
    instancePath: issue.instancePath, keyword: issue.keyword,
    ...(issue.missingProperty ? { missingProperty: issue.missingProperty } : {}),
    ...(issue.rejectedProperty ? { rejectedProperty: issue.rejectedProperty } : {}) })) } : {};
  return toolResult({ contractVersion: '1', error: { code, message: messages[code] ?? code, retryable,
    requestId: crypto.randomUUID(), ...detail } }, true);
}

/** Valid and schema-invalid calls share one path. The shared services decide
 * authorization before rejecting a body field, exactly as for HTTP. */
async function invoke(tool: StateplaneTool, args: unknown, context: McpContext,
  issues?: readonly McpFnSchemaIssue[]): Promise<ToolResult> {
  try {
    if (!context.credential) throw new TransportFailure('UNAUTHENTICATED');
    const value = await tool.run(context.services, context.credential, plain(args));
    // Return exactly the JSON an HTTP client would receive.
    return toolResult(JSON.parse(JSON.stringify(value)) as Record<string, unknown>, false);
  } catch (error) { return failure(error, tool.read, issues); }
}

/** Side-effect-free declaration: a fixed tool set, independent of collections. */
export function stateplaneMcpDeclaration(): McpFnServerDeclaration<McpContext> {
  return defineMcpFnServer<McpContext>({
    info: { ...serverInfo, instructions },
    transports: ['streamable-http'],
    tools: tools.map(tool => ({
      name: tool.name, title: tool.title, description: tool.description,
      inputSchema: tool.inputSchema, annotations: { ...tool.annotations, title: tool.title },
      handler: (args, context) => invoke(tool, args, context),
      handleInvalidArguments: (args, issues, context) => invoke(tool, args, context, issues)
    })),
    resources: [{ uri: guidanceUri, name: 'stateplane-guidance', title: 'Stateplane MCP guide',
      description: 'Generic rules for authoritative records, attributed claims, untrusted content, retries and errors.',
      mimeType: 'text/markdown',
      read: uri => ({ contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: guidance }] }) }]
  });
}

export interface McpHandlerOptions {
  services: StateplaneServices;
  identity: IdentityVerifier;
  /** Public URL of the MCP endpoint; its path is the only served MCP path. */
  resource: string | URL;
  /** AuthFn-hosted OAuth issuers published in protected-resource metadata. */
  authorizationServers: ReadonlyArray<string | URL>;
  /** Permit HTTP loopback issuers for isolated local tests only. */
  allowInsecureLoopback?: boolean;
  /** Additional browser origins allowed to call the endpoint. The resource's
   * own origin, and any loopback origin for a loopback resource, is allowed;
   * any other Origin header is rejected. */
  allowedOrigins?: readonly string[];
  /** Fallback deadline for one JSON-RPC request. */
  requestTimeoutMs?: number;
  /** Runs when the deadline answers before the services settle. */
  onTimeout?: () => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const rpcError = (status: number, code: number, message: string, id: unknown = null, data?: unknown) =>
  json(status, { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

class BodyTooLarge extends Error {}
async function readBody(request: Request): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > maxRequestBytes) throw new BodyTooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); // NOSONAR -- a stream reader advances sequentially
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxRequestBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge();
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const loopback = (hostname: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
/** Compare serialized origins; an opaque or malformed Origin never matches. */
function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch { return null; }
}

function credentialOf(value: unknown): VerifiedCredential | null {
  const credential = value as Partial<VerifiedCredential> | null | undefined;
  if (!credential || typeof credential.credentialId !== 'string' || !credential.credentialId) return null;
  if (credential.kind === 'session' && typeof credential.userPrincipalId === 'string' && credential.userPrincipalId)
    return { kind: 'session', credentialId: credential.credentialId, userPrincipalId: credential.userPrincipalId };
  if (credential.kind === 'api-key' && credential.userPrincipalId === undefined)
    return { kind: 'api-key', credentialId: credential.credentialId };
  return null;
}

/** Deadline answer for one message. A tool that may write cannot be retried. */
function timedOut(value: object): Response {
  const message = value as { id?: unknown; method?: unknown; params?: { name?: unknown } };
  if (message.method === 'tools/call') {
    const tool = typeof message.params?.name === 'string' ? byName.get(message.params.name) : undefined;
    const read = tool?.read ?? false;
    const error = new TransportFailure(read ? 'PROVIDER_UNAVAILABLE' : 'COMMIT_OUTCOME_UNKNOWN');
    return json(200, { jsonrpc: '2.0', id: message.id ?? null, result: failure(error, read) });
  }
  return rpcError(503, -32603, 'PROVIDER_UNAVAILABLE', message.id ?? null);
}

/** Streamable HTTP endpoint protected by AuthFn bearer credentials. Space
 * grants, routing and every policy decision stay in the shared services. */
export function createMcpHandler(options: McpHandlerOptions): (request: Request) => Promise<Response> {
  const resource = new URL(options.resource.toString());
  resource.hash = '';
  const metadataUrl = protectedResourceMetadataUrl(resource);
  const metadata = createProtectedResourceMetadata({ resource, authorizationServers: [...options.authorizationServers],
    allowInsecureLoopbackAuthorizationServers: options.allowInsecureLoopback ?? false, resourceName: 'Stateplane' });
  const { services, identity } = options;
  const server = stateplaneMcpDeclaration().createServer({
    context: (extra: McpFnRequestExtra) => ({ services, credential: credentialOf(extra.authInfo?.extra?.stateplaneCredential) })
  });
  const transport = server.createWebStandardHandler({ enableJsonResponse: true });
  const timeoutMs = options.requestTimeoutMs ?? 0;

  const serve = async (request: Request, handleOptions?: Parameters<Awaited<typeof transport>>[1]): Promise<Response> => {
    let text: string;
    try { text = await readBody(request); }
    catch (error) {
      if (error instanceof BodyTooLarge) return rpcError(413, -32600, 'RATE_LIMITED', null,
        { contractVersion: '1', error: { code: 'RATE_LIMITED', message: messages.RATE_LIMITED, retryable: false, requestId: crypto.randomUUID() } });
      return rpcError(400, -32700, 'Parse error');
    }
    let message: unknown;
    try { message = JSON.parse(text); } catch { return rpcError(400, -32700, 'Parse error'); }
    if (!message || typeof message !== 'object' || Array.isArray(message))
      return rpcError(400, -32600, 'Send exactly one JSON-RPC message per request');
    const handle = await transport;
    const work = handle(request, { ...handleOptions, parsedBody: message });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = await (timeoutMs > 0 ? Promise.race([work, new Promise<Response>(resolve => {
      timer = setTimeout(() => { options.onTimeout?.(); resolve(timedOut(message)); }, timeoutMs);
    })]) : work).finally(() => { if (timer) clearTimeout(timer); });
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  const authenticated = createAuthProviderMcpHandler(serve, {
    resource,
    provider: {
      async authenticateBearer(token: string, request: Request) {
        // Only the exact Bearer value reaches AuthFn; cookies never authenticate MCP.
        const credential = credentialOf(await identity.verify(new Request(request.url,
          { method: 'POST', headers: { authorization: `Bearer ${token}` } })));
        if (!credential) return null;
        return { id: credential.credentialId, type: credential.kind,
          subject: { actorId: credential.kind === 'session' ? credential.userPrincipalId : credential.credentialId,
            actorType: credential.kind === 'session' ? 'user' : 'agent' }, metadata: { credential } };
      }
    },
    map: session => ({ subject: session.subject.actorId, clientId: session.id, scopes: [], resourceIds: [resource.toString()],
      extra: { stateplaneCredential: (session.metadata as { credential: VerifiedCredential }).credential } })
  });
  const allowedOrigins = new Set([resource.origin, ...(options.allowedOrigins ?? []).map(value => originOf(value))]);
  // A loopback development resource may be fronted by local tooling on another
  // port. A DNS-rebinding page still presents its own non-loopback origin.
  const originAllowed = (value: string) => {
    const origin = originOf(value);
    return origin !== null && (allowedOrigins.has(origin) ||
      (loopback(resource.hostname) && loopback(new URL(origin).hostname)));
  };
  return async request => {
    const url = new URL(request.url);
    if (url.pathname === metadataUrl.pathname) {
      if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return json(200, metadata);
    }
    if (url.pathname !== resource.pathname) return json(404, { error: 'not_found' });
    const origin = request.headers.get('origin');
    if (origin !== null && !originAllowed(origin)) return rpcError(403, -32000, 'Origin is not allowed');
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    return authenticated(request);
  };
}
