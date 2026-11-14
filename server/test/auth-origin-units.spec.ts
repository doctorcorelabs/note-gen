// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Origin and cookie parsing units (worker V3-01cR, wave 3A).
//
// LAYER: L0 pure units against production code. These tests call
// matchCanonicalOrigin and parseSessionCookieId from
// server/src/middleware/auth-hook.ts directly, with no app, no
// verifier, and no fake. They pin normalization edges the inject
// suites do not reach: URL normalization of the Origin (lowercase
// host, default port removal, path ignored), the opaque 'null'
// origin, duplicated headers, and cookie fall-through. Cases already
// covered by server/test/auth-hook.spec.ts (basic match, Referer
// fallback, first-value-wins cookies, percent-decoding) are not
// repeated here.
//
// Sources: desain-auth.md sections 4.1, 5.3;
// server/src/middleware/auth-hook.ts (frozen shape, AD-40).

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { matchCanonicalOrigin, parseSessionCookieId } from '../src/middleware/auth-hook.js';

const CANONICAL = 'https://app.example.invalid';

describe('matchCanonicalOrigin normalization [real code]', () => {
  it('matches an upper-case host: URL parsing lowercases the host', () => {
    expect(matchCanonicalOrigin('https://APP.EXAMPLE.INVALID', undefined, CANONICAL)).toBe(true);
    expect(matchCanonicalOrigin('https://App.Example.Invalid', undefined, CANONICAL)).toBe(true);
  });

  it('matches an explicit default port and rejects a non-default port', () => {
    expect(matchCanonicalOrigin('https://app.example.invalid:443', undefined, CANONICAL)).toBe(true);
    expect(matchCanonicalOrigin('https://app.example.invalid:8443', undefined, CANONICAL)).toBe(false);
    expect(matchCanonicalOrigin('https://app.example.invalid:80', undefined, CANONICAL)).toBe(false);
  });

  it('ignores the path and query of the Origin: only the origin part is compared', () => {
    expect(matchCanonicalOrigin('https://app.example.invalid/core/main', undefined, CANONICAL)).toBe(true);
    expect(matchCanonicalOrigin('https://app.example.invalid/core/main?x=1#frag', undefined, CANONICAL)).toBe(true);
    expect(matchCanonicalOrigin('https://app.example.invalid/', undefined, CANONICAL)).toBe(true);
  });

  it('normalizes a canonical origin with a trailing slash or an explicit default port', () => {
    expect(matchCanonicalOrigin('https://app.example.invalid', undefined, 'https://app.example.invalid/')).toBe(true);
    expect(matchCanonicalOrigin('https://app.example.invalid', undefined, 'https://app.example.invalid:443')).toBe(true);
    expect(matchCanonicalOrigin('https://app.example.invalid', undefined, 'https://app.example.invalid:443/')).toBe(true);
  });

  it('rejects the opaque origin null and never falls back to the Referer once Origin is present', () => {
    expect(matchCanonicalOrigin('null', `${CANONICAL}/core/main`, CANONICAL)).toBe(false);
    expect(matchCanonicalOrigin('null', undefined, CANONICAL)).toBe(false);
  });

  it('rejects a garbage Origin and never falls back to the Referer', () => {
    expect(matchCanonicalOrigin('not a url', `${CANONICAL}/core/main`, CANONICAL)).toBe(false);
    expect(matchCanonicalOrigin('https://', `${CANONICAL}/core/main`, CANONICAL)).toBe(false);
  });

  it('falls back to the Referer only when Origin is absent or empty', () => {
    expect(matchCanonicalOrigin(undefined, `${CANONICAL}/core/main`, CANONICAL)).toBe(true);
    expect(matchCanonicalOrigin('', `${CANONICAL}/core/main`, CANONICAL)).toBe(true);
    expect(matchCanonicalOrigin('', 'https://evil.example.invalid/x', CANONICAL)).toBe(false);
  });

  it('treats a duplicated Origin header as absent: the Referer decides', () => {
    expect(matchCanonicalOrigin(['https://app.example.invalid', 'https://app.example.invalid'], `${CANONICAL}/x`, CANONICAL)).toBe(true);
    expect(matchCanonicalOrigin(['https://app.example.invalid', 'https://app.example.invalid'], undefined, CANONICAL)).toBe(false);
    expect(matchCanonicalOrigin(['https://app.example.invalid', 'https://evil.example.invalid'], undefined, CANONICAL)).toBe(false);
  });

  it('rejects a duplicated Referer header and a Referer with a wrong port', () => {
    expect(matchCanonicalOrigin(undefined, [`${CANONICAL}/x`, `${CANONICAL}/y`], CANONICAL)).toBe(false);
    expect(matchCanonicalOrigin(undefined, 'https://app.example.invalid:8443/x', CANONICAL)).toBe(false);
    expect(matchCanonicalOrigin(undefined, 'https://sub.app.example.invalid/x', CANONICAL)).toBe(false);
  });

  it('fails closed without a canonical origin or with a malformed one', () => {
    expect(matchCanonicalOrigin('https://app.example.invalid', undefined, undefined)).toBe(false);
    expect(matchCanonicalOrigin('https://app.example.invalid', undefined, '')).toBe(false);
    expect(matchCanonicalOrigin('https://app.example.invalid', undefined, 'not a url')).toBe(false);
    expect(matchCanonicalOrigin(undefined, `${CANONICAL}/x`, undefined)).toBe(false);
  });

  it('rejects suffix, scheme, and credential tricks', () => {
    expect(matchCanonicalOrigin('https://app.example.invalid.evil.invalid', undefined, CANONICAL)).toBe(false);
    expect(matchCanonicalOrigin('http://app.example.invalid', undefined, CANONICAL)).toBe(false);
    expect(matchCanonicalOrigin('https://app.example.invalid@evil.invalid', undefined, CANONICAL)).toBe(false);
    expect(matchCanonicalOrigin('https://evil.invalid#https://app.example.invalid', undefined, CANONICAL)).toBe(false);
  });
});

describe('parseSessionCookieId fall-through [real code]', () => {
  function fakeRequest(cookie: string | undefined): FastifyRequest {
    return { headers: cookie === undefined ? {} : { cookie } } as unknown as FastifyRequest;
  }

  it('falls through to the development cookie when the __Host- value is empty', () => {
    expect(parseSessionCookieId(fakeRequest('__Host-notegen_session=; notegen_session=session-valid'))).toBe('session-valid');
    expect(parseSessionCookieId(fakeRequest('notegen_session=session-valid; __Host-notegen_session='))).toBe('session-valid');
  });

  it('returns undefined when both names are empty or absent', () => {
    expect(parseSessionCookieId(fakeRequest('__Host-notegen_session=; notegen_session='))).toBeUndefined();
    expect(parseSessionCookieId(fakeRequest('other=session-valid'))).toBeUndefined();
    expect(parseSessionCookieId(fakeRequest(''))).toBeUndefined();
    expect(parseSessionCookieId(fakeRequest(undefined))).toBeUndefined();
  });

  it('tolerates surrounding whitespace around names and values', () => {
    expect(parseSessionCookieId(fakeRequest('  notegen_session = session-valid ; other=x'))).toBe('session-valid');
  });

  it('ignores cookie parts without an equals sign', () => {
    expect(parseSessionCookieId(fakeRequest('not-a-cookie;;; notegen_session=session-valid'))).toBe('session-valid');
    expect(parseSessionCookieId(fakeRequest(';;;'))).toBeUndefined();
  });

  it('uses an undecodable percent value as-is instead of throwing', () => {
    expect(parseSessionCookieId(fakeRequest('notegen_session=%E0%A4%A'))).toBe('%E0%A4%A');
  });

  it('decodes a percent-encoded value', () => {
    expect(parseSessionCookieId(fakeRequest('notegen_session=session%2Dvalid'))).toBe('session-valid');
  });
});
