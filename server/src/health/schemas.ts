// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Response schemas for the health endpoints, exactly as specified in
// desain-health-endpoint.md section 2. Fastify serializes through these
// schemas, so a malformed envelope fails hard instead of being sent as
// is. No field beyond the ones defined here may appear in a health
// response, and no field may carry configuration or user data.

const checkSchema = {
  type: 'object',
  required: ['status', 'latencyMs', 'detail', 'error'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ok', 'fail', 'skipped'] },
    latencyMs: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    detail: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    error: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

export const liveResponseSchema = {
  type: 'object',
  required: ['ok', 'status', 'service', 'version', 'uptimeSeconds', 'timestamp', 'checks'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string', enum: ['live'] },
    service: { type: 'string', enum: ['note-gen-web-api'] },
    version: { type: 'string' },
    uptimeSeconds: { type: 'integer' },
    timestamp: { type: 'string' },
    checks: {
      type: 'object',
      required: ['process'],
      additionalProperties: false,
      properties: {
        process: checkSchema,
      },
    },
  },
};

export const readyResponseSchema = {
  type: 'object',
  required: ['ok', 'status', 'service', 'version', 'uptimeSeconds', 'timestamp', 'checks'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string', enum: ['ready', 'not_ready'] },
    service: { type: 'string', enum: ['note-gen-web-api'] },
    version: { type: 'string' },
    uptimeSeconds: { type: 'integer' },
    timestamp: { type: 'string' },
    checks: {
      type: 'object',
      required: ['db', 'workspace', 'migrations', 'pgvector', 'worker'],
      additionalProperties: false,
      properties: {
        db: checkSchema,
        workspace: checkSchema,
        migrations: checkSchema,
        pgvector: checkSchema,
        worker: checkSchema,
      },
    },
  },
};
