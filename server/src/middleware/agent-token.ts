// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Agent token verification (F2-1 wave G-F2-1d, desain-auth.md
// section 11.4). The verifier implements steps 1-3 of the design
// order: Bearer header, hash lookup, then revoked/expiry/account/
// epoch checks. Every rejection returns null so the auth hook
// answers one generic 401; the reason is never distinguished to
// the client. Scope and workspace checks (steps 4-6) run in the
// hook and the agent route handlers, where the required scope and
// the target workspace are known, and answer the generic 404.
//
// A missing store or a database error throws 503, mirroring the
// session verifier: "cannot verify" is not "invalid token".
//
// The request guard (step 7) counts every authenticated agent
// request against per-token and per-account buckets, refreshes
// last_used_at with the same 15-minute throttle as sessions, and
// writes the agent_token_used audit event at most once per
// throttle window per token (the summary policy of desain-auth
// section 12.1: summarized, not one row per request). Audit and
// last_used writes are best effort: their failure is logged and
// never turns an otherwise valid request into an error, while a
// rate-limit rejection is a hard 429.

import type { FastifyRequest } from 'fastify';
import { ApiError } from '../plugins/envelope.js';
import type { AuthContext } from '../auth/context.js';
import { clientIp, hashToken, parseBearerToken } from '../auth/crypto.js';
import { unavailableOnDbError } from '../auth/service.js';
import { AUDIT_EVENT_TYPES, isAgentTokenScope, LAST_SEEN_THROTTLE_MS } from '../auth/values.js';
import { checkAndCountAgentRequest } from './rate-limit.js';
import type { AgentGuardFn, AgentPrincipal, VerifyAgentTokenFn } from './auth-hook.js';

export function createAgentTokenVerifier(context: AuthContext): VerifyAgentTokenFn {
  return async ({ request }): Promise<AgentPrincipal | null> => {
    const raw = parseBearerToken(request.headers.authorization);
    if (raw === undefined) {
      return null;
    }
    const store = context.store;
    if (store === null) {
      throw ApiError.serviceUnavailable('The database is not available.');
    }
    const row = await unavailableOnDbError(() => store.findAgentTokenByHash(hashToken(raw)));
    if (row === null) {
      return null;
    }
    if (row.revokedAt !== null) {
      return null;
    }
    const nowMs = context.clock();
    if (nowMs >= row.expiresAt.getTime()) {
      return null;
    }
    const user = await unavailableOnDbError(() => store.findUserById(row.userId));
    if (user === null || user.status !== 'active') {
      return null;
    }
    if (row.credentialEpoch !== user.credentialEpoch) {
      return null;
    }
    // Fail closed on unknown scopes (desain-auth section 11.3): a
    // scope string this build does not know grants nothing, and a
    // token whose scopes are all unknown is rejected outright.
    const scopes = row.scopes.filter((scope) => isAgentTokenScope(scope));
    if (scopes.length === 0) {
      return null;
    }
    return {
      userId: user.id,
      tokenId: row.id,
      scopes,
      workspaceIds: [...row.workspaceIds],
      pathPrefixes: row.pathPrefixes === null ? null : [...row.pathPrefixes],
      authMode: 'agent',
    };
  };
}

export interface AgentGuardOptions {
  // Per-minute request ceiling applied to both the per-token and
  // the per-account bucket. Defaults to the general account limit
  // (desain-auth section 6.5); tests inject a small value.
  limitPerMinute?: number;
}

function agentScopeOf(request: FastifyRequest): string | null {
  const raw = request as unknown as {
    routeOptions?: { config?: { agentScope?: string } };
  };
  return raw.routeOptions?.config?.agentScope ?? null;
}

export function createAgentRequestGuard(
  context: AuthContext,
  options: AgentGuardOptions = {},
): AgentGuardFn {
  return async (request, principal): Promise<void> => {
    const store = context.store;
    if (store === null) {
      throw ApiError.serviceUnavailable('The database is not available.');
    }
    const nowMs = context.clock();
    const decision = await checkAndCountAgentRequest({
      store,
      tokenId: principal.tokenId,
      userId: principal.userId,
      authSecret: context.authSecret,
      nowMs,
      limitPerMinute: options.limitPerMinute,
    });
    if (!decision.allowed) {
      throw ApiError.rateLimited();
    }
    try {
      const row = await store.findAgentTokenById(principal.tokenId);
      const stale =
        row !== null &&
        (row.lastUsedAt === null || nowMs - row.lastUsedAt.getTime() > LAST_SEEN_THROTTLE_MS);
      if (stale) {
        await store.updateAgentTokenLastUsed(principal.tokenId, new Date(nowMs));
        await store.insertAuditEvent({
          userId: principal.userId,
          actorUserId: principal.userId,
          eventType: AUDIT_EVENT_TYPES.agentTokenUsed,
          ip: clientIp(request, context.trustProxy) ?? null,
          userAgent: null,
          metadata: {
            tokenId: principal.tokenId,
            scope: agentScopeOf(request),
            method: request.method,
            path: request.url.split('?')[0] ?? request.url,
          },
        });
      }
    } catch {
      request.log.warn({ layer: 'agent-audit' }, 'agent token usage audit write failed');
    }
  };
}

// Throws the generic 404 when the agent principal lacks a scope.
// Used by handlers that need a second scope beyond the route's
// declared agentScope (desain-auth section 11.4 step 4: missing
// scope answers 404, never 403).
export function requireAgentScope(principal: AgentPrincipal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw ApiError.notFound();
  }
}

// Path-prefix jail for file routes (desain-auth section 11.4
// step 6). A null or empty prefix list means no path restriction.
// Prefixes and paths are workspace-relative; a path is inside a
// prefix when it equals the prefix or sits under it at a segment
// boundary, so "inbox" never matches "inbox2/file.md".
export function isPathWithinPrefixes(
  pathPrefixes: readonly string[] | null,
  path: string,
): boolean {
  if (pathPrefixes === null || pathPrefixes.length === 0) {
    return true;
  }
  const normalized = path.replace(/^\/+/, '');
  return pathPrefixes.some((prefix) => {
    const clean = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
    return clean !== '' && (normalized === clean || normalized.startsWith(`${clean}/`));
  });
}
