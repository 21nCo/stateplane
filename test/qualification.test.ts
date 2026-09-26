import { describe, expect, it } from 'vitest';
import { AuthFnApiKeyRevokedError, createAuthFn, authenticateApiKey, authenticateSessionToken, createApiKey, createUser, issueSession, revokeApiKeyById, revokeSessionById } from '@authfn/core';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { authFnMultiRegionPlugin, createInMemoryAuthFnPlacementDirectory } from '@authfn/multi-region';
import { McpFnRegistry, createManifest, createMcpFnServer, textResult } from '@mcpfn/core';
import { bearerChallengeResponse } from '@mcpfn/auth';
import { McpFnTestClient } from '@mcpfn/testing';
import { parseBearerChallenge } from '@mcpfn/testing/auth';
import { validateSchema } from '@datafn/core';
import { memoryAdapter } from '@superfunctions/db/testing';
import { readModelSchema } from '@stateplane/read-model';
import { parseRevision } from '@stateplane/contracts';

describe('published package boundary', () => {
  it('AuthFn composes API key and region plugins and revocation denies replay', async () => {
    const database = memoryAdapter();
    const auth = createAuthFn({ database, namespace: 'qualification', plugins: [authFnApiKeyPlugin(), authFnMultiRegionPlugin()] });
    expect(auth.getSchema()).toBeTruthy();
    const config = { database, namespace: 'qualification' };
    const key = await createApiKey(config, { userId: 'fixture-user', name: 'qualification' });
    expect((await authenticateApiKey(config, key.secret))?.metadata?.ownerUserId).toBe('fixture-user');
    await revokeApiKeyById(config, key.keyId, { userId: 'fixture-user' });
    await expect(authenticateApiKey(config, key.secret)).rejects.toBeInstanceOf(AuthFnApiKeyRevokedError);
  });

  it('AuthFn user sessions authenticate and revoke through the packed adapter contract', async () => {
    const config = { database: memoryAdapter(), namespace: 'session-qualification', plugins: [] };
    createAuthFn(config);
    const user = await createUser(config, { primaryEmail: 'fixture@example.invalid' });
    const issued = await issueSession(config, {}, { userId: user.id, methods: ['password'] });
    expect((await authenticateSessionToken(config, issued.sessionToken))?.actorId).toBe(user.id);
    await revokeSessionById(config, issued.session.id, { userId: user.id });
    expect(await authenticateSessionToken(config, issued.sessionToken)).toBeNull();
  });

  it('AuthFn identity placement compare-and-set rejects a stale epoch', async () => {
    const directory = createInMemoryAuthFnPlacementDirectory();
    const initial = { identityKey: 'fixture-user', regionId: 'cell-a', epoch: 1, state: 'active' as const, updatedAt: new Date() };
    expect((await directory.putIfAbsent(initial)).inserted).toBe(true);
    const next = { ...initial, regionId: 'cell-b', epoch: 2 };
    expect((await directory.compareAndSet({ identityKey: initial.identityKey, expectedEpoch: 1, expectedState: 'active', placement: next })).updated).toBe(true);
    expect((await directory.compareAndSet({ identityKey: initial.identityKey, expectedEpoch: 1, expectedState: 'active', placement: initial })).updated).toBe(false);
    expect((await directory.get(initial.identityKey))?.regionId).toBe('cell-b');
  });

  it('McpFn exposes a fixed tool through its real in-memory protocol client', async () => {
    const registry = new McpFnRegistry().register({
      name: 'stateplane_status', description: 'Returns scaffold status',
      inputSchema: { type: 'object', properties: {} },
      handler: () => textResult('scaffold')
    });
    const manifest = createManifest({ name: 'stateplane', version: '0.0.0' }, registry);
    expect(manifest.tools.map(tool => tool.name)).toContain('stateplane_status');
    const server = createMcpFnServer({ info: { name: 'stateplane', version: '0.0.0' }, registry });
    expect(server.manifest().tools).toHaveLength(1);
    const client = await McpFnTestClient.connect(server);
    try {
      expect((await client.listTools()).map(tool => tool.name)).toEqual(['stateplane_status']);
      expect((await client.callTool('stateplane_status')).content).toEqual([{ type: 'text', text: 'scaffold' }]);
    } finally {
      await client.close();
      await server.close();
    }
    const challenge = bearerChallengeResponse(401, new URL('https://example.test/.well-known/oauth-protected-resource'), { error: 'invalid_token', description: 'Missing credential' });
    expect(challenge.status).toBe(401);
    expect(parseBearerChallenge(challenge.headers.get('WWW-Authenticate') ?? '')).toBeTruthy();
  });

  it('DataFn accepts a fixed, read-only namespace schema', () => {
    const result = validateSchema(readModelSchema);
    expect(result).toBeTruthy();
    expect(readModelSchema.resources.map(resource => resource.name)).toEqual(['spacePlacements']);
    expect(readModelSchema.resources[0].permissions?.write?.fields).toEqual([]);
    expect(readModelSchema.resources[0].permissions?.read?.fields).toContain('storageTargetId');
    expect(readModelSchema.resources[0].fields.map(field => field.name)).toContain('storageTargetId');
  });

  it('constructs only positive safe revisions', () => {
    expect(parseRevision(1)).toBe(1);
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(() => parseRevision(value)).toThrow(RangeError);
    }
  });

  it('shared DB memory transactions roll back multi-write failure', async () => {
    const adapter = memoryAdapter();
    await expect(adapter.transaction(async tx => {
      await tx.create({ model: 'qualification', data: { id: 'record', state: 'open' } });
      await tx.create({ model: 'audit', data: { id: 'event', recordId: 'record' } });
      throw Error('interrupt');
    })).rejects.toThrow('interrupt');
    expect(await adapter.count({ model: 'qualification' })).toBe(0);
    expect(await adapter.count({ model: 'audit' })).toBe(0);
  });
});
