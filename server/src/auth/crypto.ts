// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Token, hash, cookie, and client-identity helpers for auth
// (desain-auth.md sections 1.9, 3.3, 4, 5.2, 6.1-6.2). No secret value
// ever passes through a log line from this module: helpers return
// hashes and tokens, and callers must never log the raw values.
//
// CSRF token derivation (design finding, see laporan-v3-01b-auth.md):
// desain-auth.md stores only the SHA-256 hash of the CSRF token
// (section 1.3) yet requires GET /api/auth/csrf to return the raw
// token for the current session (section 5.2). A random token cannot
// be recovered from its hash, and rotating the token inside a GET
// would violate the no-mutation-through-GET rule (section 5.4). The
// token is therefore derived deterministically as
// HMAC-SHA256(AUTH_SECRET, "notegen-csrf-v1" + NUL + session_hash),
// encoded base64url. The stored csrf_token_hash is the SHA-256 of
// that derived value, so verification stays a hash comparison and
// never needs the secret. A new session (new session hash) yields a
// new token, so rotation on login, step-up, and password change is
// preserved. The derivation needs AUTH_SECRET; without it, login and
// GET /api/auth/csrf fail closed.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

export const CSRF_DERIVATION_DOMAIN = 'notegen-csrf-v1';
export const RATE_LIMIT_KEY_DOMAIN = 'notegen-rate-limit-v1';
export const INSTALLATION_LOCK_NAME = 'notegen-installation-v1';

// SHA-256 hex (lowercase) of a raw token value. The single canonical
// token hash helper (desain-auth.md section 1.9); every auth path
// hashes tokens through here so no path can diverge.
export function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// 32 CSPRNG bytes, base64url without padding (43 characters).
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

// Agent token format (desain-auth.md section 11.2): the ngt_
// prefix plus 32 CSPRNG bytes in base64url, 47 characters in
// total. tokenPrefix is the first 8 characters after the
// prefix and last4 the final 4; together they identify a
// token in lists and logs without the raw value. Only the
// SHA-256 hash of the full raw value is ever stored.
export const AGENT_TOKEN_PREFIX = 'ngt_';

export interface GeneratedAgentToken {
  raw: string;
  tokenPrefix: string;
  last4: string;
}

export function newAgentToken(): GeneratedAgentToken {
  const raw = `${AGENT_TOKEN_PREFIX}${newOpaqueToken()}`;
  return {
    raw,
    tokenPrefix: raw.slice(AGENT_TOKEN_PREFIX.length, AGENT_TOKEN_PREFIX.length + 8),
    last4: raw.slice(-4),
  };
}

// Reads a Bearer token from an Authorization header value.
// Anything that is not exactly one Bearer credential (missing
// header, other scheme, embedded whitespace, duplicated
// headers) yields undefined; the verifier answers the same
// generic 401 for all of them.
export function parseBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = /^Bearer (\S+)$/i.exec(header.trim());
  return match?.[1];
}

// Constant-time string comparison that does not leak length: values
// of different lengths are compared through their hashes.
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length === bBuf.length) {
    return timingSafeEqual(aBuf, bBuf);
  }
  const aHash = createHash('sha256').update(aBuf).digest();
  const bHash = createHash('sha256').update(bBuf).digest();
  return timingSafeEqual(aHash, bHash);
}

export function hmacHex(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

// HMAC bucket key for rate limiting (desain-auth.md section 6.1). The
// raw identifier (IP, email, account id) never reaches the database
// or a log; only this HMAC is stored.
export function rateLimitKey(scope: string, rawValue: string, authSecret: string): string {
  return hmacHex(authSecret, `${RATE_LIMIT_KEY_DOMAIN}:${scope}\0${rawValue}`);
}

// Derive the raw CSRF token for a session from its stored hash.
// See the module header for why derivation is required.
export function deriveCsrfToken(sessionHash: string, authSecret: string): string {
  return createHmac('sha256', authSecret)
    .update(`${CSRF_DERIVATION_DOMAIN}\0${sessionHash}`, 'utf8')
    .digest()
    .toString('base64url');
}

export interface CookieOptions {
  cookieSecure: boolean;
}

// One cookie builder for set and clear (desain-auth.md section 4.1),
// so attributes can never drift between the two. The __Host- prefix
// is used exactly when Secure is on, as the prefix requires.
export function buildSessionCookie(value: string, maxAgeSeconds: number, options: CookieOptions): string {
  const name = options.cookieSecure ? '__Host-notegen_session' : 'notegen_session';
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`];
  if (options.cookieSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearSessionCookie(options: CookieOptions): string {
  return buildSessionCookie('', 0, options);
}

const BROWSER_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Edge', pattern: /Edg\//i },
  { label: 'Chrome', pattern: /Chrome\//i },
  { label: 'Firefox', pattern: /Firefox\//i },
  { label: 'Safari', pattern: /Version\/[^ ]+ Safari\//i },
  { label: 'Opera', pattern: /OPR\//i },
];

const OS_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Windows', pattern: /Windows NT/i },
  { label: 'macOS', pattern: /Macintosh|Mac OS X/i },
  { label: 'Android', pattern: /Android/i },
  { label: 'iOS', pattern: /iPhone|iPad/i },
  { label: 'Linux', pattern: /Linux/i },
];

// Server-made device label from the User-Agent (desain-auth.md
// section 1.3). Never returns the raw User-Agent; capped at 128 chars.
export function deviceLabelFromUserAgent(userAgent: string | undefined): string {
  if (userAgent === undefined || userAgent.trim() === '') {
    return 'Unknown device';
  }
  const browser = BROWSER_PATTERNS.find((entry) => entry.pattern.test(userAgent))?.label;
  const os = OS_PATTERNS.find((entry) => entry.pattern.test(userAgent))?.label;
  const parts = [browser, os].filter((part): part is string => part !== undefined);
  if (parts.length === 0) {
    return 'Unknown device';
  }
  return parts.join(' on ').slice(0, 128);
}

export function truncateUserAgent(userAgent: string | undefined): string | null {
  if (userAgent === undefined || userAgent === '') {
    return null;
  }
  return userAgent.slice(0, 512);
}

// Client IP for rate limiting and audit (desain-auth.md section 6.6).
// X-Forwarded-For is honored only when the proxy is trusted; otherwise
// the socket peer is used. Returns undefined when no usable IP exists.
export function clientIp(request: FastifyRequest, trustProxy: boolean): string | undefined {
  let candidate: string | undefined;
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
    if (first !== undefined && first !== '') {
      candidate = first;
    }
  }
  if (candidate === undefined) {
    candidate = request.ip;
  }
  if (candidate === undefined || candidate === '') {
    return undefined;
  }
  return isIP(candidate) !== 0 ? candidate : undefined;
}

export function userAgentHash(userAgent: string | undefined): string | null {
  if (userAgent === undefined || userAgent === '') {
    return null;
  }
  return hashToken(userAgent);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isPlausibleEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (normalized.length < 3 || normalized.length > 254) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
