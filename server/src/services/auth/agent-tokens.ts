// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Agent token management service (F2-1 wave G-F2-1d, desain-auth.md
// section 11.5). Creation, listing, and revocation run over the
// cookie-authenticated management routes; this module owns body
// validation, the one-time raw value, and the audit writes. The
// raw token value exists only in the creation return value: it is
// never stored, never logged, and never readable again (only its
// SHA-256 hash reaches the database, through the store).

import { ApiError } from '../../plugins/envelope.js';
import type { AuthContext } from '../../auth/context.js';
import { hashToken, isUuid, newAgentToken } from '../../auth/crypto.js';
import { unavailableOnDbError } from '../../auth/service.js';
import { requireStore } from '../../auth/context.js';
import type { AgentTokenRow } from '../../auth/store.js';
import {
  AGENT_TOKEN_DEFAULT_TTL_MS,
  AGENT_TOKEN_MAX_TTL_MS,
  AGENT_TOKEN_NAME_MAX_LENGTH,
  AUDIT_EVENT_TYPES,
  isAgentTokenScope,
  type AgentTokenScope,
} from '../../auth/values.js';

export interface CreateAgentTokenBody {
  name: string;
  scopes: AgentTokenScope[];
  workspaceIds: string[];
  expiresAt: Date;
  pathPrefixes: string[] | null;
}

const CREATE_FIELDS = new Set(['name', 'scopes', 'workspaceIds', 'expiresAt', 'pathPrefixes']);
const PATH_PREFIX_MAX_LENGTH = 512;
const PATH_PREFIX_MAX_COUNT = 32;

function validationError(field: string): never {
  throw ApiError.validation('Request validation failed.', { field });
}

// Validates the POST /api/agent/tokens body (desain-auth section
// 11.5): name up to 128 characters, at least one known scope,
// workspace ids as UUIDs, expiresAt defaulting to 90 days and
// capped at 365 days, optional path prefixes. Unknown fields are
// rejected. Workspace ownership is checked in createAgentToken,
// where the store is available.
export function parseCreateAgentTokenBody(body: unknown, nowMs: number): CreateAgentTokenBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiError.validation('The request body must be an object.');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CREATE_FIELDS.has(key)) {
      validationError(key);
    }
  }

  const rawName = record['name'];
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    validationError('name');
  }
  const name = (rawName as string).trim();
  if (name.length > AGENT_TOKEN_NAME_MAX_LENGTH) {
    validationError('name');
  }

  const rawScopes = record['scopes'];
  if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
    validationError('scopes');
  }
  const scopes: AgentTokenScope[] = [];
  for (const entry of rawScopes as unknown[]) {
    if (!isAgentTokenScope(entry)) {
      validationError('scopes');
    }
    if (!scopes.includes(entry)) {
      scopes.push(entry);
    }
  }

  const workspaceIds: string[] = [];
  const rawWorkspaces = record['workspaceIds'];
  if (rawWorkspaces !== undefined) {
    if (!Array.isArray(rawWorkspaces)) {
      validationError('workspaceIds');
    }
    for (const entry of rawWorkspaces as unknown[]) {
      if (typeof entry !== 'string' || !isUuid(entry)) {
        validationError('workspaceIds');
      }
      if (!workspaceIds.includes(entry)) {
        workspaceIds.push(entry);
      }
    }
  }

  let expiresAt = new Date(nowMs + AGENT_TOKEN_DEFAULT_TTL_MS);
  const rawExpires = record['expiresAt'];
  if (rawExpires !== undefined) {
    if (typeof rawExpires !== 'string') {
      validationError('expiresAt');
    }
    const parsed = Date.parse(rawExpires as string);
    if (!Number.isFinite(parsed)) {
      validationError('expiresAt');
    }
    expiresAt = new Date(parsed);
  }
  if (expiresAt.getTime() <= nowMs || expiresAt.getTime() > nowMs + AGENT_TOKEN_MAX_TTL_MS) {
    validationError('expiresAt');
  }

  let pathPrefixes: string[] | null = null;
  const rawPrefixes = record['pathPrefixes'];
  if (rawPrefixes !== undefined && rawPrefixes !== null) {
    if (!Array.isArray(rawPrefixes) || rawPrefixes.length > PATH_PREFIX_MAX_COUNT) {
      validationError('pathPrefixes');
    }
    pathPrefixes = [];
    for (const entry of rawPrefixes as unknown[]) {
      if (typeof entry !== 'string') {
        validationError('pathPrefixes');
      }
      const clean = (entry as string).trim().replace(/^\/+/, '').replace(/\/+$/, '');
      if (
        clean === '' ||
        clean.length > PATH_PREFIX_MAX_LENGTH ||
        clean.includes('\\') ||
        clean.split('/').some((segment) => segment === '..' || segment === '.')
      ) {
        validationError('pathPrefixes');
      }
      if (!pathPrefixes.includes(clean)) {
        pathPrefixes.push(clean);
      }
    }
    if (pathPrefixes.length === 0) {
      pathPrefixes = null;
    }
  }

  return { name, scopes, workspaceIds, expiresAt, pathPrefixes };
}

export interface ApiAgentToken {
  id: string;
  name: string;
  tokenPrefix: string;
  last4: string;
  scopes: string[];
  workspaceIds: string[];
  pathPrefixes: string[] | null;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

// Metadata-only representation. The token hash is never exposed.
export function toApiAgentToken(row: AgentTokenRow): ApiAgentToken {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    last4: row.last4,
    scopes: [...row.scopes],
    workspaceIds: [...row.workspaceIds],
    pathPrefixes: row.pathPrefixes === null ? null : [...row.pathPrefixes],
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreatedAgentToken {
  // The raw value, returned exactly once to the creator.
  raw: string;
  row: AgentTokenRow;
}

// Creates a token for the authenticated owner. Every workspace id
// must belong to the owner; any foreign or unknown id answers the
// generic 404 without naming which one (desain-auth section
// 11.5). The audit event is written in the same transaction as
// the token row by the store.
export async function createAgentToken(
  context: AuthContext,
  input: {
    userId: string;
    credentialEpoch: number;
    body: CreateAgentTokenBody;
    ip: string | null;
    userAgent: string | null;
    nowMs: number;
  },
): Promise<CreatedAgentToken> {
  const store = requireStore(context);
  for (const workspaceId of input.body.workspaceIds) {
    const workspace = await unavailableOnDbError(() => store.findWorkspaceById(workspaceId));
    if (workspace === null || workspace.ownerUserId !== input.userId) {
      throw ApiError.notFound();
    }
  }
  const generated = newAgentToken();
  const row = await unavailableOnDbError(() =>
    store.createAgentToken(
      {
        userId: input.userId,
        tokenHash: hashToken(generated.raw),
        tokenPrefix: generated.tokenPrefix,
        last4: generated.last4,
        name: input.body.name,
        scopes: [...input.body.scopes],
        workspaceIds: [...input.body.workspaceIds],
        pathPrefixes: input.body.pathPrefixes,
        credentialEpoch: input.credentialEpoch,
        expiresAt: input.body.expiresAt,
        createdAt: new Date(input.nowMs),
        createdByIp: input.ip,
      },
      (tokenId) => ({
        userId: input.userId,
        actorUserId: input.userId,
        eventType: AUDIT_EVENT_TYPES.agentTokenCreated,
        ip: input.ip,
        userAgent: input.userAgent,
        metadata: { tokenId, name: input.body.name, scopes: [...input.body.scopes] },
      }),
    ),
  );
  return { raw: generated.raw, row };
}

// Revokes one of the owner's tokens. Unknown, foreign, or
// already-revoked ids answer the generic 404. Revocation is
// immediate: the next verification sees revoked_at set.
export async function revokeAgentToken(
  context: AuthContext,
  input: {
    userId: string;
    tokenId: string;
    ip: string | null;
    userAgent: string | null;
    nowMs: number;
  },
): Promise<void> {
  const store = requireStore(context);
  const revoked = await unavailableOnDbError(() =>
    store.revokeAgentToken(input.userId, input.tokenId, new Date(input.nowMs), {
      userId: input.userId,
      actorUserId: input.userId,
      eventType: AUDIT_EVENT_TYPES.agentTokenRevoked,
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: { tokenId: input.tokenId },
    }),
  );
  if (!revoked) {
    throw ApiError.notFound();
  }
}
