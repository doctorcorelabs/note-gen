// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Authentication and CSRF hook shell (foundation wiring only).
//
// This module defines the INTERFACES the auth worker implements and the
// hook that enforces them. It contains no session database lookup, no
// password or token cryptography, and no CSRF hash comparison. The full
// logic belongs to the auth worker (desain-auth.md); this file is the
// wiring point that worker plugs into by injecting verifiers into
// buildApp.
//
// Deny-by-default rules (never allow-by-default):
// - When no verifySession is injected, every protected route answers
//   401. There is no mode in which a missing verifier means "allow".
// - A route is protected when its config sets requiresAuth: true, or
//   when it has no explicit config and lives under /api/. Only routes
//   with requiresAuth: false, and the health paths below, are public.
//   A future route that forgets its config is protected, not public.
// - When no CSRF verifier is injected, authenticated mutations answer
//   403. A verified session alone is never enough for a mutation.
// - When no canonical origin is configured, Origin checks fail closed
//   and authenticated mutations answer 403.
//
// Check order for a protected mutation (desain-auth.md section 5.3):
// session first (401 when invalid), then Origin (403), then the CSRF
// token (403). Origin and CSRF failures share one generic client-visible
// message; they are distinguished only by code, csrf_invalid versus
// origin_rejected (kontrak-api-kanonis.md section 1.2). Only the server
// log records which layer failed. The rejected Origin value may be
// logged (it is not a secret); token values are never logged.
//
// Unmatched paths never reach this hook's checks: Fastify runs global
// preHandler hooks even for 404s, and an unmatched /api/* path must
// answer 404 from the not-found handler, not 401 from this hook. A
// request is treated as unmatched when the router attached no route
// URL (Fastify 5 leaves routeOptions.url undefined for 404s, including
// wrong-method requests to an existing path).
//
// Health paths are public by design: orchestrator probes and container
// healthchecks carry no credentials, and a 401 from the API itself
// would break watchdog diagnosis. The Cloudflare Access perimeter
// still guards public probes. This exemption is tested explicitly.
// Two more no-session paths are exempt as wiring only (their endpoints
// belong to other workers): POST /api/csp-reports, which browsers send
// without a session, and GET /api/backups/downloads/:downloadToken,
// which authenticates with its single-use token in the path
// (kontrak-api-kanonis.md section 10.7 item 4). No endpoint is built
// here; the exemptions only keep the hook from 401ing those routes
// when they land.
//
// Public mutation routes (login, setup) are NOT covered by the global
// hook: they have no session yet, so CSRF token checks cannot apply.
// The auth worker attaches createOriginPreHandler to those routes for
// the Origin layer, per desain-auth.md sections 3.1 and 5.3.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../plugins/envelope.js';
import { HEALTH_PATHS } from '../routes/health.js';

// Route config keys understood by the auth hook. Declared here so route
// registrations can set them with type checking; the merge applies to
// the whole program because this file is part of the build.
declare module 'fastify' {
  interface FastifyContextConfig {
    requiresAuth?: boolean;
    requiresCsrf?: boolean;
    // F2-1 wave G-F2-1d: routes with authMode 'agent' verify a
    // Bearer agent token instead of the session cookie and
    // skip Origin/CSRF (Bearer is not an ambient credential).
    // agentScope names the single scope the route requires;
    // a token without it answers the generic 404.
    authMode?: 'session' | 'agent';
    agentScope?: string;
    // DA-6 A17-01: per-route 413 mapping read by the error handler.
    bodyTooLarge?: import('../plugins/envelope.js').BodyTooLargeMapping;
  }
}

export interface SessionPrincipal {
  userId: string;
  role: 'user' | 'admin';
  sessionId: string;
  credentialEpoch?: number;
}

// Agent principal (desain-auth.md section 11.4): deliberately
// separate from SessionPrincipal. A handler that needs a
// browser session never accepts this shape, and agent
// handlers read it back with getAgentPrincipal.
export interface AgentPrincipal {
  userId: string;
  tokenId: string;
  scopes: readonly string[];
  workspaceIds: readonly string[];
  pathPrefixes: readonly string[] | null;
  authMode: 'agent';
}

export interface AgentVerificationInput {
  request: FastifyRequest;
}

// Verify a Bearer agent token. Returns the agent principal
// when the token is valid, or null for every rejection (no
// header, unknown hash, revoked, expired, inactive owner,
// stale credential epoch, no known scope). All of those
// answer the same generic 401. A missing store or database
// error throws 503, mirroring the session verifier.
export type VerifyAgentTokenFn = (input: AgentVerificationInput) => Promise<AgentPrincipal | null>;

// Post-verification guard for agent routes: per-token and
// per-account rate limits plus usage audit (desain-auth.md
// section 11.4 step 7). Throws ApiError.rateLimited when a
// bucket is exhausted.
export type AgentGuardFn = (request: FastifyRequest, principal: AgentPrincipal) => Promise<void>;

export interface SessionVerificationInput {
  request: FastifyRequest;
  sessionId: string | undefined;
}

// Verify a browser session from its opaque cookie id. Returns the
// principal when the session is valid, or null when it is missing,
// unknown, expired, revoked, or owned by a disabled account. All of
// those cases answer with the same generic 401; the verifier must not
// distinguish them in any client-visible way. A verifier that throws
// fails closed through the global error handler (generic 500 envelope,
// still denied), and the throw is logged with its code only.
export type VerifySessionFn = (input: SessionVerificationInput) => Promise<SessionPrincipal | null>;

// Verify the CSRF token for an authenticated mutation. The token travels
// in the X-CSRF-Token header (desain-auth.md section 5.2). Returns true
// only when the token matches the session's stored hash. The request
// gives access to headers; the principal gives the session identity.
export type VerifyCsrfTokenFn = (request: FastifyRequest, principal: SessionPrincipal) => Promise<boolean>;

// Verify the Origin/Referer layer for an authenticated mutation.
// canonicalOrigin is the normalized origin from PUBLIC_BASE_URL, or
// undefined when it is not configured (which must fail closed).
export type VerifyOriginFn = (
  request: FastifyRequest,
  canonicalOrigin: string | undefined,
) => boolean | Promise<boolean>;

export interface AuthHookDeps {
  verifySession?: VerifySessionFn;
  verifyCsrf?: VerifyCsrfTokenFn;
  verifyOrigin?: VerifyOriginFn;
  verifyAgentToken?: VerifyAgentTokenFn;
  agentGuard?: AgentGuardFn;
  canonicalOrigin?: string | undefined;
}

// Stub verifiers. These are the ONLY defaults: both deny. They exist so
// the foundation is secure before the auth worker lands, and so tests
// can assert deny-by-default behavior without a database.
export const denyByDefaultVerifySession: VerifySessionFn = async () => null;

export const denyByDefaultVerifyCsrf: VerifyCsrfTokenFn = async () => false;
export const denyByDefaultVerifyAgentToken: VerifyAgentTokenFn = async () => null;

// Health paths that bypass application auth. Single source of truth is
// the route module; the middleware contract test asserts the exemption
// explicitly (desain-auth.md section 12.4, item 8).
export const PUBLIC_HEALTH_PATHS: readonly string[] = HEALTH_PATHS;

// No-session paths beyond health (wiring only, see the header comment).
// The CSP report path is exact and POST-only.
// DA-6 A26-04: the former GET /api/backups/downloads/<token>
// exemption was removed. No route serves that prefix (backup
// endpoints are excluded by AD-114), so the exemption only let a
// future download route inherit token-in-path no-session access
// without a new decision. Reintroduce it together with the route
// and its own token validation when backups are built.
export const CSP_REPORT_PATH = '/api/csp-reports';

export function isPublicNoSessionRequest(method: string, path: string): boolean {
  if (PUBLIC_HEALTH_PATHS.includes(path)) {
    return true;
  }
  if (method === 'POST' && path === CSP_REPORT_PATH) {
    return true;
  }
  return false;
}

export const SESSION_COOKIE_NAMES: readonly string[] = ['__Host-notegen_session', 'notegen_session'];

export const CSRF_HEADER_NAME = 'x-csrf-token';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isMutationMethod(method: string): boolean {
  return MUTATION_METHODS.has(method.toUpperCase());
}

// Parse the session id from the Cookie header. The production name
// (__Host- prefix) is tried first, then the development name. Cookie
// values are percent-decoded when possible; an undecodable value is
// used as-is and will simply fail verification server-side.
export function parseSessionCookieId(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header === '') {
    return undefined;
  }
  const values = new Map<string, string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (name === '' || values.has(name)) {
      continue;
    }
    try {
      values.set(name, decodeURIComponent(raw));
    } catch {
      values.set(name, raw);
    }
  }
  for (const name of SESSION_COOKIE_NAMES) {
    const value = values.get(name);
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

// Read the CSRF token from its canonical header. Missing, empty, or
// duplicated headers yield undefined (deny). This helper is shared so
// the auth worker's verifier and this shell read the header identically.
export function readCsrfTokenHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers[CSRF_HEADER_NAME];
  if (typeof raw !== 'string' || raw === '') {
    return undefined;
  }
  return raw;
}

// Pure Origin/Referer matcher (desain-auth.md section 5.3). The Origin
// must equal the canonical origin exactly after URL normalization
// (lowercase host, default port removed). When Origin is absent, the
// Referer origin must equal the canonical origin. When both are
// absent, or when no canonical origin is configured, the check fails.
// The string 'null' (opaque origin) never matches.
export function matchCanonicalOrigin(
  origin: string | string[] | undefined,
  referer: string | string[] | undefined,
  canonicalOrigin: string | undefined,
): boolean {
  if (canonicalOrigin === undefined || canonicalOrigin === '') {
    return false;
  }
  let canonical: string;
  try {
    canonical = new URL(canonicalOrigin).origin;
  } catch {
    return false;
  }
  if (typeof origin === 'string' && origin !== '') {
    try {
      return new URL(origin).origin === canonical;
    } catch {
      return false;
    }
  }
  if (typeof referer === 'string' && referer !== '') {
    try {
      return new URL(referer).origin === canonical;
    } catch {
      return false;
    }
  }
  return false;
}

export function defaultVerifyOrigin(request: FastifyRequest, canonicalOrigin: string | undefined): boolean {
  return matchCanonicalOrigin(request.headers.origin, request.headers.referer, canonicalOrigin);
}

interface RouteInfo {
  config: {
    requiresAuth?: boolean;
    requiresCsrf?: boolean;
    authMode?: 'session' | 'agent';
    agentScope?: string;
  };
  pattern: string | undefined;
  // False when the router matched no route (404, including a
  // wrong-method request to an existing path). In Fastify 5 an
  // unmatched request still carries a routeOptions object, but with
  // no url or method fields; a matched request always has both.
  matched: boolean;
}

function routeInfo(request: FastifyRequest): RouteInfo {
  const raw = request as unknown as {
    routeOptions?: { config?: RouteInfo['config']; url?: string; method?: string };
    routeConfig?: RouteInfo['config'];
  };
  if (raw.routeOptions !== undefined) {
    return {
      config: raw.routeOptions.config ?? {},
      pattern: raw.routeOptions.url,
      matched: raw.routeOptions.url !== undefined,
    };
  }
  // Fastify 4 shape: routeConfig IS the config object, present only
  // when a route matched.
  return { config: raw.routeConfig ?? {}, pattern: undefined, matched: raw.routeConfig !== undefined };
}

function requestPath(request: FastifyRequest): string {
  const url = request.url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

// Attach the verified principal to the request without augmenting the
// FastifyRequest type. Handlers read it back with getPrincipal.
const PRINCIPAL_KEY = 'principal';

export function getPrincipal(request: FastifyRequest): SessionPrincipal | undefined {
  const holder = request as unknown as Record<string, unknown>;
  const value = holder[PRINCIPAL_KEY];
  if (typeof value === 'object' && value !== null && typeof (value as SessionPrincipal).userId === 'string') {
    return value as SessionPrincipal;
  }
  return undefined;
}

function setPrincipal(request: FastifyRequest, principal: SessionPrincipal): void {
  (request as unknown as Record<string, unknown>)[PRINCIPAL_KEY] = principal;
}

const AGENT_PRINCIPAL_KEY = 'agentPrincipal';

export function getAgentPrincipal(request: FastifyRequest): AgentPrincipal | undefined {
  const holder = request as unknown as Record<string, unknown>;
  const value = holder[AGENT_PRINCIPAL_KEY];
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as AgentPrincipal).authMode === 'agent' &&
    typeof (value as AgentPrincipal).tokenId === 'string'
  ) {
    return value as AgentPrincipal;
  }
  return undefined;
}

function setAgentPrincipal(request: FastifyRequest, principal: AgentPrincipal): void {
  (request as unknown as Record<string, unknown>)[AGENT_PRINCIPAL_KEY] = principal;
}

export function createAuthPreHandler(deps: AuthHookDeps = {}) {
  const verifySession = deps.verifySession ?? denyByDefaultVerifySession;
  const verifyOrigin = deps.verifyOrigin ?? defaultVerifyOrigin;
  const verifyCsrf = deps.verifyCsrf ?? denyByDefaultVerifyCsrf;
  const verifyAgentToken = deps.verifyAgentToken ?? denyByDefaultVerifyAgentToken;
  const agentGuard = deps.agentGuard;
  const canonicalOrigin = deps.canonicalOrigin;

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const info = routeInfo(request);
    const path = requestPath(request);
    // Unmatched paths are the not-found handler's job, never this
    // hook's: answering 401 here would mask a 404 and, for health-like
    // paths, could be converted into a misleading 503 upstream.
    if (!info.matched) {
      return;
    }
    const pattern = info.pattern ?? path;
    if (info.config.requiresAuth === false) {
      return;
    }
    if (isPublicNoSessionRequest(request.method, path) || PUBLIC_HEALTH_PATHS.includes(pattern)) {
      return;
    }
    // Agent branch (F2-1 wave G-F2-1d): only routes that
    // explicitly declare authMode 'agent' take this path, so
    // every pre-existing route keeps the session behavior
    // below unchanged. The cookie is ignored here and the
    // Bearer token is ignored on session routes. A missing
    // required scope answers the generic 404 (desain-auth
    // section 11.4 step 4), never 403.
    if (info.config.authMode === 'agent') {
      const agentPrincipal = await verifyAgentToken({ request });
      if (agentPrincipal === null) {
        throw ApiError.unauthenticated();
      }
      const requiredScope = info.config.agentScope;
      if (requiredScope !== undefined && !agentPrincipal.scopes.includes(requiredScope)) {
        throw ApiError.notFound();
      }
      setAgentPrincipal(request, agentPrincipal);
      if (agentGuard !== undefined) {
        await agentGuard(request, agentPrincipal);
      }
      return;
    }
    const requiresAuth = info.config.requiresAuth === true || path.startsWith('/api/') || pattern.startsWith('/api/');
    if (!requiresAuth) {
      return;
    }

    const principal = await verifySession({ request, sessionId: parseSessionCookieId(request) });
    if (principal === null) {
      throw ApiError.unauthenticated();
    }
    setPrincipal(request, principal);

    if (!isMutationMethod(request.method) || info.config.requiresCsrf === false) {
      return;
    }

    const originOk = await verifyOrigin(request, canonicalOrigin);
    if (!originOk) {
      request.log.warn(
        { layer: 'origin', origin: request.headers.origin ?? null },
        'mutation rejected by origin check',
      );
      throw ApiError.originRejected();
    }
    const csrfOk = await verifyCsrf(request, principal);
    if (!csrfOk) {
      request.log.warn({ layer: 'csrf' }, 'mutation rejected by csrf check');
      throw ApiError.csrfInvalid();
    }
  };
}

export function registerAuthHooks(app: FastifyInstance, deps: AuthHookDeps = {}): void {
  app.addHook('preHandler', createAuthPreHandler(deps));
}

// Standalone Origin check for public mutation routes (login, setup),
// where no session exists yet and the global hook does not run. The
// auth worker attaches this as a route preHandler. It enforces exactly
// the same matcher as the authenticated path, with the same generic
// 403 outcome and the origin_rejected code.
export function createOriginPreHandler(canonicalOrigin: string | undefined) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!defaultVerifyOrigin(request, canonicalOrigin)) {
      request.log.warn(
        { layer: 'origin', origin: request.headers.origin ?? null },
        'public mutation rejected by origin check',
      );
      throw ApiError.originRejected();
    }
  };
}
