// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Unit tests for the pushed auth foundations (V3-01b): token/crypto
// helpers, Argon2id hashing, TOTP verification and sealing, and the
// shared value constants. These pin the primitives every auth route
// builds on; route behavior is covered in auth-routes.spec.ts.

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  buildSessionCookie,
  clearSessionCookie,
  clientIp,
  deriveCsrfToken,
  deviceLabelFromUserAgent,
  hashToken,
  isPlausibleEmail,
  newOpaqueToken,
  normalizeEmail,
  rateLimitKey,
  safeEqual,
  truncateUserAgent,
} from '../../src/auth/crypto.js';
import { Argon2PasswordHasher, passwordShapeIssue } from '../../src/auth/passwords.js';
import { deriveSealKey, sealTotpSecret, unsealTotpSecret } from '../../src/auth/totp-seal.js';
import {
  currentTotpCounter,
  decodeBase32,
  isTotpCodeShape,
  normalizeRecoveryCode,
  totpCodeAt,
  verifyTotpCode,
} from '../../src/auth/totp-verify.js';
import { LOGIN_CHALLENGE_MAX_ATTEMPTS, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../../src/auth/values.js';
import { TEST_ENCRYPTION_KEY } from './helpers.js';

const SECRET = 'JBSWY3DPEHPK3PXP';
const NOW_MS = Date.UTC(2026, 10, 15, 4, 0, 0);

describe('token and hash helpers', () => {
  it('hashes tokens deterministically as lowercase hex', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('generates 43-character base64url opaque tokens', () => {
    const a = newOpaqueToken();
    const b = newOpaqueToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('compares strings in constant time without leaking length', () => {
    expect(safeEqual('same', 'same')).toBe(true);
    expect(safeEqual('same', 'diff')).toBe(false);
    expect(safeEqual('short', 'a much longer value')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('derives CSRF tokens deterministically per session and secret', () => {
    const a = deriveCsrfToken('hash-1', 'secret-1');
    expect(a).toBe(deriveCsrfToken('hash-1', 'secret-1'));
    expect(a).not.toBe(deriveCsrfToken('hash-2', 'secret-1'));
    expect(a).not.toBe(deriveCsrfToken('hash-1', 'secret-2'));
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keys rate limit buckets with HMAC, never the raw value', () => {
    const key = rateLimitKey('login:ip', '203.0.113.7', 'secret-1');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('203.0.113.7');
    expect(key).toBe(rateLimitKey('login:ip', '203.0.113.7', 'secret-1'));
    expect(key).not.toBe(rateLimitKey('login:account_ip', '203.0.113.7', 'secret-1'));
  });
});

describe('session cookies', () => {
  it('uses the __Host- prefix exactly when Secure is on', () => {
    const secure = buildSessionCookie('tok', 3600, { cookieSecure: true });
    expect(secure).toContain('__Host-notegen_session=tok');
    expect(secure).toContain('Secure');
    expect(secure).toContain('HttpOnly');
    expect(secure).toContain('SameSite=Lax');
    expect(secure).toContain('Max-Age=3600');
    expect(secure).toContain('Path=/');
    const plain = buildSessionCookie('tok', 3600, { cookieSecure: false });
    expect(plain.startsWith('notegen_session=tok')).toBe(true);
    expect(plain).not.toContain('Secure');
  });

  it('clears with Max-Age=0 under the same name', () => {
    expect(clearSessionCookie({ cookieSecure: true })).toBe('__Host-notegen_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
    expect(clearSessionCookie({ cookieSecure: false })).toContain('Max-Age=0');
  });
});

describe('client identity helpers', () => {
  it('labels devices from the User-Agent without returning it', () => {
    expect(deviceLabelFromUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0')).toBe('Chrome on Windows');
    expect(deviceLabelFromUserAgent(undefined)).toBe('Unknown device');
    expect(deviceLabelFromUserAgent('')).toBe('Unknown device');
    expect(deviceLabelFromUserAgent('curl/8.0')).toBe('Unknown device');
  });

  it('truncates the stored User-Agent at 512 characters', () => {
    expect(truncateUserAgent(undefined)).toBe(null);
    expect(truncateUserAgent('a'.repeat(600))?.length).toBe(512);
  });

  it('honors X-Forwarded-For only when the proxy is trusted', () => {
    const forwarded = {
      headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.1' },
      ip: '10.0.0.9',
    } as unknown as FastifyRequest;
    expect(clientIp(forwarded, true)).toBe('203.0.113.7');
    expect(clientIp(forwarded, false)).toBe('10.0.0.9');
    const spoofed = { headers: { 'x-forwarded-for': 'not-an-ip' }, ip: '10.0.0.9' } as unknown as FastifyRequest;
    expect(clientIp(spoofed, true)).toBeUndefined();
  });

  it('normalizes and plausibility-checks emails', () => {
    expect(normalizeEmail('  Alice@Example.ORG ')).toBe('alice@example.org');
    expect(isPlausibleEmail('alice@example.org')).toBe(true);
    expect(isPlausibleEmail('not-an-email')).toBe(false);
    expect(isPlausibleEmail('a@b')).toBe(false);
    expect(isPlausibleEmail('')).toBe(false);
  });
});

describe('password shape and Argon2id', () => {
  it('accepts 12-128 code points and rejects the rest', () => {
    expect(passwordShapeIssue('twelve-chars')).toBeNull();
    expect(passwordShapeIssue('short')).not.toBeNull();
    expect(passwordShapeIssue('a'.repeat(129))).not.toBeNull();
    expect(passwordShapeIssue('has\0nul')).not.toBeNull();
    expect(passwordShapeIssue(42)).not.toBeNull();
  });

  it('hashes and verifies with Argon2id and needs no immediate rehash', async () => {
    const hasher = new Argon2PasswordHasher();
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(hash, 'wrong password here')).toBe(false);
    expect(await hasher.verify('not-a-phc-string', 'whatever password')).toBe(false);
    expect(hasher.needsRehash(hash)).toBe(false);
  }, 30000);
});

describe('TOTP verification', () => {
  it('verifies the current code and rejects a wrong one', () => {
    const counter = currentTotpCounter(NOW_MS);
    const code = totpCodeAt(decodeBase32(SECRET), counter);
    expect(isTotpCodeShape(code)).toBe(true);
    expect(verifyTotpCode({ secretBase32: SECRET, code, nowMs: NOW_MS, lastUsedStep: null }).valid).toBe(true);
    expect(verifyTotpCode({ secretBase32: SECRET, code: '000000', nowMs: NOW_MS, lastUsedStep: null }).valid).toBe(
      false,
    );
  });

  it('accepts the neighboring steps in the window', () => {
    const counter = currentTotpCounter(NOW_MS);
    const previous = totpCodeAt(decodeBase32(SECRET), counter - 1);
    const next = totpCodeAt(decodeBase32(SECRET), counter + 1);
    expect(verifyTotpCode({ secretBase32: SECRET, code: previous, nowMs: NOW_MS, lastUsedStep: null }).valid).toBe(true);
    expect(verifyTotpCode({ secretBase32: SECRET, code: next, nowMs: NOW_MS, lastUsedStep: null }).valid).toBe(true);
    const far = totpCodeAt(decodeBase32(SECRET), counter + 2);
    expect(verifyTotpCode({ secretBase32: SECRET, code: far, nowMs: NOW_MS, lastUsedStep: null }).valid).toBe(false);
  });

  it('rejects replayed steps as replayed, not as valid', () => {
    const counter = currentTotpCounter(NOW_MS);
    const code = totpCodeAt(decodeBase32(SECRET), counter);
    const result = verifyTotpCode({ secretBase32: SECRET, code, nowMs: NOW_MS, lastUsedStep: counter });
    expect(result).toEqual({ valid: false, reason: 'replayed' });
  });

  it('rejects malformed codes and secrets without throwing', () => {
    expect(verifyTotpCode({ secretBase32: SECRET, code: 'abc', nowMs: NOW_MS, lastUsedStep: null }).valid).toBe(false);
    expect(verifyTotpCode({ secretBase32: '!!!', code: '123456', nowMs: NOW_MS, lastUsedStep: null }).valid).toBe(false);
    expect(() => decodeBase32('!!!')).toThrow();
  });

  it('normalizes recovery codes', () => {
    expect(normalizeRecoveryCode(' ABCD-efgh IJKL ')).toBe('abcdefghijkl');
  });
});

describe('TOTP sealing', () => {
  it('round-trips a secret and fails closed on tampering', () => {
    const key = deriveSealKey(TEST_ENCRYPTION_KEY);
    expect(key).not.toBeNull();
    expect(key?.length).toBe(32);
    const sealed = sealTotpSecret(SECRET, key as Buffer);
    expect(sealed).not.toContain(SECRET);
    expect(unsealTotpSecret(sealed, key as Buffer, 1)).toBe(SECRET);
    expect(unsealTotpSecret(sealed, key as Buffer, 2)).toBeNull();
    expect(unsealTotpSecret(`${sealed.slice(0, -2)}AA`, key as Buffer, 1)).toBeNull();
    expect(unsealTotpSecret('not-base64url!!!', key as Buffer, 1)).toBeNull();
  });

  it('derives seal keys deterministically and rejects missing keys', () => {
    expect(deriveSealKey(undefined)).toBeNull();
    expect(deriveSealKey('')).toBeNull();
    const hex = deriveSealKey('ab'.repeat(32));
    expect(hex?.length).toBe(32);
    const passphrase = deriveSealKey('a passphrase shaped value');
    expect(passphrase?.length).toBe(32);
    expect(passphrase?.equals(deriveSealKey('a passphrase shaped value') as Buffer)).toBe(true);
  });
});

describe('auth value constants', () => {
  it('pins the session lifetimes and challenge budget', () => {
    expect(SESSION_ABSOLUTE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(SESSION_IDLE_MS).toBe(24 * 60 * 60 * 1000);
    expect(LOGIN_CHALLENGE_MAX_ATTEMPTS).toBe(5);
  });
});
