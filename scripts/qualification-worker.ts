import { createAuthFn } from '@authfn/core';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { authFnMultiRegionPlugin } from '@authfn/multi-region';
import { createMcpFnServer } from '@mcpfn/core';
import { createOAuthResourceServerHandler } from '@mcpfn/auth';
import { defineSchema } from '@datafn/core';
import { createDatafnServer } from '@datafn/server';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createR2StorageAdapter } from '@superfunctions/storage-r2';
import { createObservability } from '@superfunctions/observability';

// Bundle probe only: no credentials or adapters are created at module load.
const exportsPresent = [createAuthFn, authFnApiKeyPlugin, authFnMultiRegionPlugin,
  createMcpFnServer, createOAuthResourceServerHandler,
  defineSchema, createDatafnServer, memoryAdapter, createR2StorageAdapter,
  createObservability].every(value => typeof value === 'function');

export default { fetch: () => Response.json({ exportsPresent }) };
