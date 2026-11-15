// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Cloudflare Access JWT verification at the origin (desain-auth.md
// section 7; kontrak-api-kanonis.md section 1.2 item 5; V3-02 part 5).
//
// Position: Access is a PERIMETER layer only. It never replaces
// session auth, never selects an account, never creates a session,
// and never authorizes anything. A request with a valid Access JWT
// but no application session still answers 401 from the session
// hook; a request with a valid session but an expired Access JWT is
// rejected here before it reaches the session hook. The verified
// principal this module returns carries the perimeter identity for
// AUDIT correlation only, and is stored under its own request key,
// never under the session principal key.
//
// This module is SEPARATE from the frozen session hook
// (middleware/auth-hook.ts, AD-40), which this task must not modify.
// The integrator wires the preHandler from this module in front of
// the session hook at merge time (verification order: Access, rate
// limit, session, CSRF/Origin). Until then, nothing calls this code
// in production.
//
// Verification algorithm (desain-auth.md section 7.3), all steps
// mandatory, one failure rejects:
//  1. JWT from the Cf-Access-Jwt-Assertion header ONLY. No other
//     header, query param, cookie, or body field is accepted.
//  2. Three Base64URL segments, valid JSON header and payload.
//  3. Header alg MUST be RS256; kid must be present and non-empty.
//  4. JWKS from https://<team domain>/cdn-cgi/access/certs, cached
//     in memory with a TTL; on an unknown kid, reload once and
//     re-check. Any JWKS failure fails CLOSED (reject).
//  5. RS256 signature verified against the JWKS key with the
//     matching kid. Claims are read only AFTER the signature
//     verifies; there is no decode-without-verify path.
//  6. exp: the token must not be expired (now < exp), with a leeway
//     of at most 60 seconds, default 0, applied to exp only.
//  7. aud: exact match against CF_ACCESS_AUD, or against
//     CF_ACCESS_SERVICE_AUD when that is configured. No prefix or
//     suffix matching; an array aud passes when one member matches.
//  8. iss: exact match against https://<team domain>, no trailing
//     slash.
//  9. email: required and non-empty for application-audience tokens.
//     For service-audience tokens (aud matches CF_ACCESS_SERVICE_AUD
//     only), the email claim is optional: assumption A3 (the shape
//     of a service token's identity claims) is still open, and the
//     interim rule records the sub claim when present instead of
//     assuming an email. The G5 deploy test must confirm or revise
//     this rule with a real service token before the first deploy.
//
// Fail-closed rules:
// - Any verification error, any JWKS error, and any misconfiguration
//   rejects. There is no "accept on error" path anywhere.
// - When verification is enabled, a missing audience or team domain
//   is a boot-time refusal (already enforced by loadConfig); this
//   module re-checks at verifier construction and throws, so a
//   verifier can never be built half-configured.
// - The raw JWT value is never logged. Logs carry only the kid, aud,
//   iss, exp, and a categorical failure reason.
// - Raw identity headers (Cf-Access-Authenticated-User-Email) are
//   never trusted: the preHandler deletes that header from the
//   request before the handler runs, so no handler can read it.
//
// Implementation note: signature verification uses Node's built-in
// crypto only (createPublicKey from a JWK, crypto.verify with
// RSA-SHA256). No JWT dependency is added: the frozen lockfile is
// the integrator's to regenerate (W-10/N-8), and the stdlib path
// keeps this overlap task to new files only. The verifier never
// parses claims before the signature check, which is the property
// the "maintained JWT library" requirement in desain-auth.md section
// 7.3 exists to guarantee.
//
// Scope and exemptions (desain-auth.md section 7.5): by default this
// preHandler verifies EVERY request it sees, including health paths.
// The live-probe exemption is a network-origin decision (internal
// compose network versus the public Caddy path), never a header
// decision, so it cannot live in this module as a path list. The
// integrator supplies an isExempt predicate only when the infra
// owner has fixed the network-origin mechanism; until then, no
// exemption exists and probes through the public path must carry a
// valid service token.

import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../plugins/envelope.js';
import { DEFAULT_JWKS_CACHE_TTL_SECONDS, type ServerConfig } from '../config/index.js';

export const CF_ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const CF_ACCESS_RAW_EMAIL_HEADER = 'cf-access-authenticated-user-email';

export const CF_ACCESS_JWKS_PATH = '/cdn-cgi/access/certs';
export const CF_ACCESS_MAX_LEEWAY_SECONDS = 60;

// Categorical failure reasons. These are safe to log and safe to
// expose to the operator; the client always sees one generic 401.
export type CfAccessFailureReason =
  | 'missing_token'
  | 'misconfigured'
  | 'malformed_token'
  | 'bad_alg'
  | 'missing_kid'
  | 'jwks_unavailable'
  | 'unknown_kid'
  | 'bad_signature'
  | 'expired'
  | 'aud_mismatch'
  | 'iss_mismatch'
  | 'missing_email';

// Perimeter principal: audit correlation only. It is NOT a session
// principal and must never be used to select an account, build a
// session, or authorize a request. email is null only for
// service-audience tokens without an email claim (see step 9 above).
export interface CfAccessPrincipal {
  email: string | null;
  subject: string | null;
  aud: string;
  iss: string;
  expiresAtSeconds: number;
}

export type CfAccessVerificationResult =
  | { ok: true; principal: CfAccessPrincipal }
  | { ok: false; reason: CfAccessFailureReason };

export interface CfAccessConfig {
  enabled: boolean;
  teamDomain: string | undefined;
  aud: string | undefined;
  serviceAud: string | undefined;
  jwksCacheTtlSeconds: number;
  leewaySeconds: number;
}

// Resolve the verifier config from the validated ServerConfig. The
// config loader already refuses boot for the enabled-but-incomplete
// cases; this re-check throws with the variable NAME only (never a
// value), so a verifier built from any other source fails closed
// the same way. Leeway above the 60 second cap is a misconfiguration.
export function resolveCfAccessConfig(config: ServerConfig, leewaySeconds = 0): CfAccessConfig {
  if (!Number.isInteger(leewaySeconds) || leewaySeconds < 0 || leewaySeconds > CF_ACCESS_MAX_LEEWAY_SECONDS) {
    throw new Error('CF_ACCESS leeway must be an integer between 0 and 60 seconds.');
  }
  const resolved: CfAccessConfig = {
    enabled: config.cfAccessEnabled,
    teamDomain: config.cfAccessTeamDomain,
    aud: config.cfAccessAud,
    serviceAud: config.cfAccessServiceAud,
    jwksCacheTtlSeconds: config.cfAccessJwksCacheTtlSeconds,
    leewaySeconds,
  };
  if (resolved.enabled) {
    assertEnabledConfig(resolved);
  }
  return resolved;
}

function assertEnabledConfig(config: CfAccessConfig): void {
  if (config.aud === undefined || config.aud === '') {
    throw new Error('CF_ACCESS_AUD must be set when CF_ACCESS_ENABLED is true.');
  }
  if (config.teamDomain === undefined || config.teamDomain === '' || !isValidTeamDomain(config.teamDomain)) {
    throw new Error('CF_ACCESS_TEAM_DOMAIN must be set to a bare team domain when CF_ACCESS_ENABLED is true.');
  }
  if (!Number.isFinite(config.jwksCacheTtlSeconds) || config.jwksCacheTtlSeconds <= 0) {
    throw new Error('CF_ACCESS_JWKS_CACHE_TTL_SECONDS must be a positive number.');
  }
}

// A team domain is a bare hostname: no scheme, no userinfo, no port,
// no path, no trailing slash, no whitespace. Anything else would let
// a misconfiguration build a JWKS URL or an expected issuer that
// does not point at the team's Access deployment.
export function isValidTeamDomain(value: string): boolean {
  if (value === '' || value !== value.trim()) {
    return false;
  }
  if (value.includes('/') || value.includes('\\') || value.includes('@') || value.includes(':')) {
    return false;
  }
  if (value.includes(' ')) {
    return false;
  }
  const labels = value.split('.');
  if (labels.length < 2) {
    return false;
  }
  return labels.every((label) => /^[A-Za-z0-9-]+$/.test(label) && !label.startsWith('-') && !label.endsWith('-'));
}

export function expectedIssuer(teamDomain: string): string {
  return `https://${teamDomain}`;
}

export function jwksUrl(teamDomain: string): string {
  return `https://${teamDomain}${CF_ACCESS_JWKS_PATH}`;
}

interface Jwk {
  kty?: unknown;
  kid?: unknown;
  use?: unknown;
  n?: unknown;
  e?: unknown;
}

interface JwksDocument {
  keys?: unknown;
}

export type FetchJwksFn = (url: string) => Promise<unknown>;

// Default JWKS fetch over the global fetch: HTTPS only (the URL is
// built from a validated bare hostname), non-200 rejected, and the
// body parsed as JSON. Any failure rejects, and the caller fails
// closed. The response body is never logged.
async function defaultFetchJwks(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
  });
  if (response.status !== 200) {
    throw new Error(`JWKS fetch failed with status ${response.status}.`);
  }
  return (await response.json()) as unknown;
}

export interface CfAccessVerifierDeps {
  fetchJwks?: FetchJwksFn;
  clock?: () => number;
  onJwksFailure?: (error: unknown) => void;
}

export interface CfAccessVerifier {
  verify(token: string | undefined): Promise<CfAccessVerificationResult>;
}

function base64UrlDecode(segment: string): Buffer | null {
  if (segment === '' || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    return null;
  }
  try {
    return Buffer.from(segment, 'base64url');
  } catch {
    return null;
  }
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function jwksKeys(document: unknown): Jwk[] | null {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return null;
  }
  const keys = (document as JwksDocument).keys;
  if (!Array.isArray(keys)) {
    return null;
  }
  const parsed: Jwk[] = [];
  for (const entry of keys) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null;
    }
    parsed.push(entry as Jwk);
  }
  return parsed;
}

function keyObjectFor(jwk: Jwk): KeyObject | null {
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    return null;
  }
  try {
    return createPublicKey({ format: 'jwk', key: jwk as unknown as Record<string, unknown> });
  } catch {
    return null;
  }
}

function audMatches(claim: unknown, allowed: string[]): string | null {
  if (typeof claim === 'string') {
    return allowed.includes(claim) ? claim : null;
  }
  if (Array.isArray(claim)) {
    for (const member of claim) {
      if (typeof member === 'string' && allowed.includes(member)) {
        return member;
      }
    }
  }
  return null;
}

// Build a verifier for one Access deployment. The JWKS cache lives in
// the closure: one verifier instance per application, so the cache is
// shared across requests and keyed by fetch time. Construction throws
// on misconfiguration (see resolveCfAccessConfig); verification
// itself never throws for a bad token, it returns a reason.
export function createCfAccessVerifier(config: CfAccessConfig, deps: CfAccessVerifierDeps = {}): CfAccessVerifier {
  if (!config.enabled) {
    throw new Error('CF_ACCESS verification is disabled; do not build a verifier for a disabled deployment.');
  }
  assertEnabledConfig(config);
  const teamDomain = config.teamDomain as string;
  const appAud = config.aud as string;
  const allowedAudiences = config.serviceAud !== undefined ? [appAud, config.serviceAud] : [appAud];
  const issuer = expectedIssuer(teamDomain);
  const url = jwksUrl(teamDomain);
  const ttlMs = config.jwksCacheTtlSeconds * 1000;
  const fetchJwks = deps.fetchJwks ?? defaultFetchJwks;
  const clock = deps.clock ?? Date.now;
  const onJwksFailure = deps.onJwksFailure;

  let cachedKeys: Jwk[] | null = null;
  let cachedAtMs = 0;

  async function loadJwks(): Promise<Jwk[] | null> {
    let document: unknown;
    try {
      document = await fetchJwks(url);
    } catch (error) {
      onJwksFailure?.(error);
      return null;
    }
    const keys = jwksKeys(document);
    if (keys === null) {
      onJwksFailure?.(new Error('JWKS document has no usable keys array.'));
      return null;
    }
    cachedKeys = keys;
    cachedAtMs = clock();
    return keys;
  }

  async function keysFor(kid: string): Promise<{ found: Jwk | null; jwksOk: boolean }> {
    const now = clock();
    let keys = cachedKeys;
    if (keys === null || now - cachedAtMs >= ttlMs) {
      keys = await loadJwks();
      if (keys === null) {
        // A stale cache is never trusted after a failed reload:
        // fail closed rather than verify against expired keys.
        return { found: null, jwksOk: false };
      }
    }
    const found = keys.find((key) => key.kid === kid) ?? null;
    if (found !== null) {
      return { found, jwksOk: true };
    }
    // Unknown kid: reload once, then re-check (key rotation). A
    // second miss is a rejection, not a loop.
    keys = await loadJwks();
    if (keys === null) {
      return { found: null, jwksOk: false };
    }
    return { found: keys.find((key) => key.kid === kid) ?? null, jwksOk: true };
  }

  return {
    async verify(token: string | undefined): Promise<CfAccessVerificationResult> {
      if (token === undefined || token === '') {
        return { ok: false, reason: 'missing_token' };
      }
      const segments = token.split('.');
      if (segments.length !== 3) {
        return { ok: false, reason: 'malformed_token' };
      }
      const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
      const headerBytes = base64UrlDecode(headerSegment);
      const signature = base64UrlDecode(signatureSegment);
      if (headerBytes === null || signature === null || signature.length === 0) {
        return { ok: false, reason: 'malformed_token' };
      }
      const header = parseJsonObject(headerBytes);
      if (header === null) {
        return { ok: false, reason: 'malformed_token' };
      }
      if (header.alg !== 'RS256') {
        return { ok: false, reason: 'bad_alg' };
      }
      const kid = header.kid;
      if (typeof kid !== 'string' || kid === '') {
        return { ok: false, reason: 'missing_kid' };
      }
      const { found, jwksOk } = await keysFor(kid);
      if (found === null) {
        // Distinguish "JWKS could not be loaded at all" from "loaded
        // but no matching kid": the operator response differs (an
        // outage versus a stale or foreign token), while the client
        // sees the same generic 401 either way. jwksOk is the
        // authority, not cache presence: a stale cache must not
        // relabel a failed reload as an unknown kid.
        return { ok: false, reason: jwksOk ? 'unknown_kid' : 'jwks_unavailable' };
      }
      const keyObject = keyObjectFor(found);
      if (keyObject === null) {
        return { ok: false, reason: 'unknown_kid' };
      }
      let signatureOk = false;
      try {
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${headerSegment}.${payloadSegment}`, 'utf8');
        signatureOk = verifier.verify(keyObject, signature);
      } catch {
        signatureOk = false;
      }
      if (!signatureOk) {
        return { ok: false, reason: 'bad_signature' };
      }
      // Claims are parsed only after the signature has verified.
      const payloadBytes = base64UrlDecode(payloadSegment);
      if (payloadBytes === null) {
        return { ok: false, reason: 'malformed_token' };
      }
      const claims = parseJsonObject(payloadBytes);
      if (claims === null) {
        return { ok: false, reason: 'malformed_token' };
      }
      const exp = claims.exp;
      if (typeof exp !== 'number' || !Number.isFinite(exp)) {
        return { ok: false, reason: 'expired' };
      }
      const nowSeconds = Math.floor(clock() / 1000);
      if (nowSeconds >= exp + config.leewaySeconds) {
        return { ok: false, reason: 'expired' };
      }
      const matchedAud = audMatches(claims.aud, allowedAudiences);
      if (matchedAud === null) {
        return { ok: false, reason: 'aud_mismatch' };
      }
      if (claims.iss !== issuer) {
        return { ok: false, reason: 'iss_mismatch' };
      }
      const isServiceToken = config.serviceAud !== undefined && matchedAud === config.serviceAud && matchedAud !== appAud;
      const email = claims.email;
      if (!isServiceToken) {
        if (typeof email !== 'string' || email === '') {
          return { ok: false, reason: 'missing_email' };
        }
      }
      const subject = typeof claims.sub === 'string' && claims.sub !== '' ? claims.sub : null;
      return {
        ok: true,
        principal: {
          email: typeof email === 'string' && email !== '' ? email : null,
          subject,
          aud: matchedAud,
          iss: issuer,
          expiresAtSeconds: exp,
        },
      };
    },
  };
}

// Default resolved config for a deployment with verification
// disabled (dev local only; loadConfig already refuses disabled
// verification in production or on a non-localhost origin). Kept as
// a helper so wiring code never hand-builds a half-filled config.
export function disabledCfAccessConfig(): CfAccessConfig {
  return {
    enabled: false,
    teamDomain: undefined,
    aud: undefined,
    serviceAud: undefined,
    jwksCacheTtlSeconds: DEFAULT_JWKS_CACHE_TTL_SECONDS,
    leewaySeconds: 0,
  };
}

// The perimeter principal lives under its own request key. Handlers
// read it back with getCfAccessPrincipal; it is never a session
// principal and must never be passed where a SessionPrincipal is
// expected.
const CF_ACCESS_PRINCIPAL_KEY = 'cfAccessPrincipal';

export function getCfAccessPrincipal(request: FastifyRequest): CfAccessPrincipal | undefined {
  const holder = request as unknown as Record<string, unknown>;
  const value = holder[CF_ACCESS_PRINCIPAL_KEY];
  if (typeof value === 'object' && value !== null && typeof (value as CfAccessPrincipal).aud === 'string') {
    return value as CfAccessPrincipal;
  }
  return undefined;
}

function setCfAccessPrincipal(request: FastifyRequest, principal: CfAccessPrincipal): void {
  (request as unknown as Record<string, unknown>)[CF_ACCESS_PRINCIPAL_KEY] = principal;
}

// Read the JWT from its one canonical header. A missing, empty, or
// duplicated header yields undefined (reject). Header names are
// lowercased by Node, so the lookup is case-insensitive by
// construction.
export function readCfAccessJwtHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers[CF_ACCESS_JWT_HEADER];
  if (typeof raw !== 'string' || raw === '') {
    return undefined;
  }
  return raw;
}

export interface CfAccessPreHandlerOptions {
  // Network-origin exemption predicate (desain-auth.md section 7.5).
  // Only the infra owner supplies this, and only with a mechanism
  // that cannot be forged from outside (for example a separate
  // internal listener). It must NEVER inspect headers. When absent,
  // every request is verified.
  isExempt?: (request: FastifyRequest) => boolean;
}

// Fastify preHandler for the perimeter layer. Register it BEFORE the
// session hook. On any failure it throws the generic 401
// unauthenticated error: the client cannot distinguish "JWKS down"
// from "token wrong", and no distinction is useful to the client.
// The failure reason is logged with categorical fields only (kid,
// aud, iss, exp, reason); the token value is never logged. The raw
// identity header is deleted from every request, verified or not, so
// no downstream handler can mistake it for an authenticated value.
export function createCfAccessPreHandler(verifier: CfAccessVerifier, options: CfAccessPreHandlerOptions = {}) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    delete (request.headers as Record<string, unknown>)[CF_ACCESS_RAW_EMAIL_HEADER];
    if (options.isExempt !== undefined && options.isExempt(request)) {
      return;
    }
    const token = readCfAccessJwtHeader(request);
    const result = await verifier.verify(token);
    if (!result.ok) {
      request.log.warn({ layer: 'cf-access', reason: result.reason }, 'request rejected by Cloudflare Access verification');
      throw ApiError.unauthenticated();
    }
    setCfAccessPrincipal(request, result.principal);
  };
}
