import { defineSchema } from '@datafn/core';

// Fixed, derived metadata only. Runtime collections and mutation authority are not DataFn resources.
export const readModelSchema = defineSchema({
  namespaced: true,
  resources: [{
    name: 'spacePlacements', version: 1,
    fields: [
      { name: 'id', type: 'string', required: true, readonly: true },
      { name: 'cellId', type: 'string', required: true, readonly: true },
      { name: 'storageTargetId', type: 'string', required: true, readonly: true },
      { name: 'generation', type: 'number', required: true, readonly: true },
      { name: 'state', type: 'string', required: true, readonly: true }
    ],
    permissions: { read: { fields: ['id', 'cellId', 'storageTargetId', 'generation', 'state'] }, write: { fields: [] } }
  }]
});
