// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for Cloudflare Access JWT verification at the origin
// (desain-auth.md section 7; kontrak-api-kanonis.md section 1.2 item
// 5). The verifier under test lives in
// middleware/cf-access.ts (a NEW module, separate from the frozen
// session hook); this spec file keeps the task-brief name
// access-jwt.spec.ts.
//
// Tokens are signed here with real RSA keys from node:crypto, and
// the JWKS fetch and clock are injected, so no network access and no
// wall-clock dependence exist anywhere in this file.
//
// What is pinned: a valid token passes with the perimeter principal;
// expired, wrong-aud, wrong-iss, bad-signature, malformed, bad-alg,
// and missing-kid tokens fail closed with categorical reasons;
// missing tokens fail closed; any JWKS failure fails closed
// (including a failed reload after a primed cache); an unknown kid
// triggers exactly one JWKS reload (key rotation); the cache is
// honored inside its TTL and refreshed after it; the email claim is
// required for application-audience tokens and optional for
// service-audience tokens (the A3 interim rule); misconfiguration
// (enabled without aud/team domain, bad team domain, leeway above
// 60 seconds) throws at construction; and when Access is not
// configured (CF_ACCESS_ENABLED=false) the check is inert: no
// verifier is built and no preHandler is installed, which is the
// desain-auth.md section 7.6 dev-local rule, while production
// without Access refuses to boot in the config loader itself.

import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/plugins/envelope.js';
import {
  createCfAccessPreHandler,
  createCfAccessVerifier,
  disabledCfAccessConfig,
  expectedIssuer,
  isValidTeamDomain,
  jwksUrl,
  readCfAccessJwtHeader,
  resolveCfAccessConfig,
  getCfAccessPrincipal,
  type CfAccessConfig,
  type CfAccessVerifier,
} from '../src/middleware/cf-access.js';
import { testConfig } from './auth/helpers.js';

const TEAM_DOMAIN = 'team.cloudflareaccess.com';
const APP_AUD = 'app-audience-tag';
const SERVICE_AUD = 'service-audience-tag';
const NOW_MS = Date.UTC(2026, 10, 15, 4, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function signToken(
  key: KeyObject,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput, 'utf8').sign(key);
  return `${signingInput}.${signature.toString('base64url')}`;
}

interface KeyMaterial {
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(kid: string): KeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = publicKey.export({ format: 'jwk' });
  return { privateKey, jwk: { ...exported, kid, use: 'sig', alg: 'RS256' } };
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: APP_AUD,
    iss: `https://${TEAM_DOMAIN}`,
    exp: NOW_SECONDS + 300,
    email: 'owner@example.invalid',
    sub: 'subject-1',
    ...overrides,
  };
}

function enabledConfig(overrides: Partial<CfAccessConfig> = {}): CfAccessConfig {
  return {
    enabled: true,
    teamDomain: TEAM_DOMAIN,
    aud: APP_AUD,
    serviceAud: SERVICE_AUD,
    jwksCacheTtlSeconds: 3600,
    leewaySeconds: 0,
    ...overrides,
  };
}

interface VerifierHarness {
  verifier: CfAccessVerifier;
  fetches: string[];
  clock: { nowMs: number };
}

function makeVerifier(
  config: CfAccessConfig,
  jwksDocs: unknown[],
  options: { failFetch?: boolean } = {},
): VerifierHarness {
  const fetches: string[] = [];
  const clock = { nowMs: NOW_MS };
  let call = 0;
  const verifier = createCfAccessVerifier(config, {
    clock: () => clock.nowMs,
    fetchJwks: async (url: string) => {
      fetches.push(url);
      if (options.failFetch === true) {
        throw new Error('simulated JWKS outage');
      }
      const doc = jwksDocs[Math.min(call, jwksDocs.length - 1)];
      call += 1;
      return doc;
    },
  });
  return { verifier, fetches, clock };
}

function fakeRequest(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return {
    headers: { ...headers },
    log: { warn: () => undefined },
  } as unknown as FastifyRequest;
}

describe('Cloudflare Access JWT verification', () => {
  describe('valid tokens', () => {
    it('passes a valid token and returns the perimeter principal', async () => {
      const key = makeKey('key-1');
      const { verifier, fetches } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1', typ: 'JWT' }, validPayload());
      const result = await verifier.verify(token);
      expect(result).toEqual({
        ok: true,
        principal: {
          email: 'owner@example.invalid',
          subject: 'subject-1',
          aud: APP_AUD,
          iss: `https://${TEAM_DOMAIN}`,
          expiresAtSeconds: NOW_SECONDS + 300,
        },
      });
      expect(fetches).toEqual([`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`]);
    });

    it('passes when an array aud contains the configured audience', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const token = signToken(
        key.privateKey,
        { alg: 'RS256', kid: 'key-1' },
        validPayload({ aud: ['something-else', APP_AUD] }),
      );
      const result = await verifier.verify(token);
      expect(result.ok).toBe(true);
    });

    it('passes a service-audience token without an email claim, recording sub (A3 interim rule)', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const payload = validPayload({ aud: SERVICE_AUD });
      delete payload.email;
      const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1' }, payload);
      const result = await verifier.verify(token);
      expect(result).toEqual({
        ok: true,
        principal: {
          email: null,
          subject: 'subject-1',
          aud: SERVICE_AUD,
          iss: `https://${TEAM_DOMAIN}`,
          expiresAtSeconds: NOW_SECONDS + 300,
        },
      });
    });
  });

  describe('fail-closed rejections', () => {
    it('rejects a missing or empty token', async () => {
      const key = makeKey('key-1');
      const { verifier, fetches } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      expect(await verifier.verify(undefined)).toEqual({ ok: false, reason: 'missing_token' });
      expect(await verifier.verify('')).toEqual({ ok: false, reason: 'missing_token' });
      expect(fetches).toHaveLength(0);
    });

    it('rejects malformed tokens', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      expect(await verifier.verify('only.two')).toEqual({ ok: false, reason: 'malformed_token' });
      expect(await verifier.verify('a.b.c.d')).toEqual({ ok: false, reason: 'malformed_token' });
      expect(await verifier.verify(`${base64url('not json')}.${base64url('{}')}.AAAA`)).toEqual({
        ok: false,
        reason: 'malformed_token',
      });
      expect(await verifier.verify('!!!.@@@.###')).toEqual({ ok: false, reason: 'malformed_token' });
    });

    it('rejects any alg other than RS256 before touching the signature', async () => {
      const key = makeKey('key-1');
      const { verifier, fetches } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const signingInput = `${base64url(JSON.stringify({ alg: 'HS256', kid: 'key-1' }))}.${base64url(JSON.stringify(validPayload()))}`;
      const hmac = createHmac('sha256', 'not-a-key').update(signingInput).digest().toString('base64url');
      expect(await verifier.verify(`${signingInput}.${hmac}`)).toEqual({ ok: false, reason: 'bad_alg' });
      const noneInput = `${base64url(JSON.stringify({ alg: 'none', kid: 'key-1' }))}.${base64url(JSON.stringify(validPayload()))}`;
      expect(await verifier.verify(`${noneInput}.AAAA`)).toEqual({ ok: false, reason: 'bad_alg' });
      expect(fetches).toHaveLength(0);
    });

    it('rejects a token without a kid', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const token = signToken(key.privateKey, { alg: 'RS256' }, validPayload());
      expect(await verifier.verify(token)).toEqual({ ok: false, reason: 'missing_kid' });
    });

    it('rejects a token signed by a different key', async () => {
      const trusted = makeKey('key-1');
      const attacker = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [trusted.jwk] }]);
      const token = signToken(attacker.privateKey, { alg: 'RS256', kid: 'key-1' }, validPayload());
      expect(await verifier.verify(token)).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects a token whose payload was tampered with after signing', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1' }, validPayload());
      const [header, , signature] = token.split('.');
      const tampered = `${header}.${base64url(JSON.stringify(validPayload({ email: 'attacker@example.invalid' })))}.${signature}`;
      expect(await verifier.verify(tampered)).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects an expired token, including at the exact exp boundary', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      for (const exp of [NOW_SECONDS - 1, NOW_SECONDS]) {
        const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1' }, validPayload({ exp }));
        expect(await verifier.verify(token)).toEqual({ ok: false, reason: 'expired' });
      }
    });

    it('applies leeway to exp only, up to the 60 second cap', async () => {
      const key = makeKey('key-1');
      const token = signToken(
        key.privateKey,
        { alg: 'RS256', kid: 'key-1' },
        validPayload({ exp: NOW_SECONDS - 30 }),
      );
      const strict = makeVerifier(enabledConfig({ leewaySeconds: 0 }), [{ keys: [key.jwk] }]);
      expect(await strict.verifier.verify(token)).toEqual({ ok: false, reason: 'expired' });
      const lenient = makeVerifier(enabledConfig({ leewaySeconds: 60 }), [{ keys: [key.jwk] }]);
      expect((await lenient.verifier.verify(token)).ok).toBe(true);
    });

    it('rejects a wrong aud, with no prefix or suffix matching', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      for (const aud of ['wrong-audience', `${APP_AUD}-suffix`, `prefix-${APP_AUD}`, ['nope', 'also-nope']]) {
        const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1' }, validPayload({ aud }));
        expect(await verifier.verify(token)).toEqual({ ok: false, reason: 'aud_mismatch' });
      }
    });

    it('rejects a wrong iss, including a trailing slash', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      for (const iss of ['https://other.cloudflareaccess.com', `https://${TEAM_DOMAIN}/`, `http://${TEAM_DOMAIN}`]) {
        const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1' }, validPayload({ iss }));
        expect(await verifier.verify(token)).toEqual({ ok: false, reason: 'iss_mismatch' });
      }
    });

    it('rejects an application-audience token without a usable email claim', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const missing = validPayload();
      delete missing.email;
      const empty = validPayload({ email: '' });
      for (const payload of [missing, empty]) {
        const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1' }, payload);
        expect(await verifier.verify(token)).toEqual({ ok: false, reason: 'missing_email' });
      }
    });

    it('rejects an unknown kid after exactly one reload', async () => {
      const key = makeKey('key-1');
      const { verifier, fetches } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-unknown' }, validPayload());
      expect(await verifier.verify(token)).toEqual({ ok: false, reason: 'unknown_kid' });
      expect(fetches).toHaveLength(2);
    });
  });

  describe('JWKS handling', () => {
    it('fails closed when the JWKS fetch throws or returns an unusable document', async () => {
      const key = makeKey('key-1');
      const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1' }, validPayload());
      const outage = makeVerifier(enabledConfig(), [], { failFetch: true });
      expect(await outage.verifier.verify(token)).toEqual({ ok: false, reason: 'jwks_unavailable' });
      for (const doc of [null, {}, { keys: 'not-an-array' }, { keys: [null] }, 'text']) {
        const broken = makeVerifier(enabledConfig(), [doc]);
        expect(await broken.verifier.verify(token)).toEqual({ ok: false, reason: 'jwks_unavailable' });
      }
    });

    it('fails closed as jwks_unavailable when a reload fails after the cache was primed', async () => {
      const key = makeKey('key-1');
      const clock = { nowMs: NOW_MS };
      let fail = false;
      let calls = 0;
      const verifier = createCfAccessVerifier(enabledConfig({ jwksCacheTtlSeconds: 60 }), {
        clock: () => clock.nowMs,
        fetchJwks: async () => {
          calls += 1;
          if (fail) {
            throw new Error('simulated JWKS outage');
          }
          return { keys: [key.jwk] };
        },
      });
      const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1' }, validPayload());
      expect((await verifier.verify(token)).ok).toBe(true);
      fail = true;
      clock.nowMs += 61_000;
      expect(await verifier.verify(token)).toEqual({ ok: false, reason: 'jwks_unavailable' });
      expect(calls).toBe(2);
    });

    it('picks up a rotated key on the single reload', async () => {
      const oldKey = makeKey('key-old');
      const newKey = makeKey('key-new');
      const { verifier, fetches } = makeVerifier(enabledConfig(), [
        { keys: [oldKey.jwk] },
        { keys: [oldKey.jwk, newKey.jwk] },
      ]);
      const token = signToken(newKey.privateKey, { alg: 'RS256', kid: 'key-new' }, validPayload());
      expect((await verifier.verify(token)).ok).toBe(true);
      expect(fetches).toHaveLength(2);
    });

    it('honors the cache inside its TTL and refreshes after it', async () => {
      const key = makeKey('key-1');
      const harness = makeVerifier(enabledConfig({ jwksCacheTtlSeconds: 60 }), [{ keys: [key.jwk] }]);
      const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1' }, validPayload());
      expect((await harness.verifier.verify(token)).ok).toBe(true);
      expect((await harness.verifier.verify(token)).ok).toBe(true);
      expect(harness.fetches).toHaveLength(1);
      harness.clock.nowMs += 61_000;
      expect((await harness.verifier.verify(token)).ok).toBe(true);
      expect(harness.fetches).toHaveLength(2);
    });
  });

  describe('configuration and the inert-when-unconfigured rule', () => {
    it('resolves an enabled config from ServerConfig', () => {
      const config = resolveCfAccessConfig(
        testConfig({ cfAccessEnabled: true, cfAccessTeamDomain: TEAM_DOMAIN, cfAccessAud: APP_AUD }),
      );
      expect(config).toMatchObject({ enabled: true, teamDomain: TEAM_DOMAIN, aud: APP_AUD, leewaySeconds: 0 });
    });

    it('throws when enabled but aud, team domain, or team domain shape is missing', () => {
      expect(() =>
        resolveCfAccessConfig(testConfig({ cfAccessEnabled: true, cfAccessTeamDomain: TEAM_DOMAIN })),
      ).toThrow('CF_ACCESS_AUD');
      expect(() =>
        resolveCfAccessConfig(testConfig({ cfAccessEnabled: true, cfAccessAud: APP_AUD })),
      ).toThrow('CF_ACCESS_TEAM_DOMAIN');
      expect(() =>
        resolveCfAccessConfig(
          testConfig({
            cfAccessEnabled: true,
            cfAccessTeamDomain: `https://${TEAM_DOMAIN}`,
            cfAccessAud: APP_AUD,
          }),
        ),
      ).toThrow('CF_ACCESS_TEAM_DOMAIN');
    });

    it('throws when leeway is outside 0 to 60 seconds', () => {
      const config = testConfig({ cfAccessEnabled: true, cfAccessTeamDomain: TEAM_DOMAIN, cfAccessAud: APP_AUD });
      expect(() => resolveCfAccessConfig(config, 61)).toThrow();
      expect(() => resolveCfAccessConfig(config, -1)).toThrow();
      expect(() => resolveCfAccessConfig(config, 0.5)).toThrow();
      expect(resolveCfAccessConfig(config, 60).leewaySeconds).toBe(60);
    });

    it('is inert when Access is not configured: a disabled config builds no verifier', () => {
      const resolved = resolveCfAccessConfig(testConfig({ cfAccessEnabled: false }));
      expect(resolved.enabled).toBe(false);
      expect(() => createCfAccessVerifier(resolved)).toThrow();
      expect(() => createCfAccessVerifier(disabledCfAccessConfig())).toThrow();
      expect(disabledCfAccessConfig()).toMatchObject({
        enabled: false,
        teamDomain: undefined,
        aud: undefined,
        serviceAud: undefined,
      });
    });

    it('validates team domains, issuers, and JWKS urls', () => {
      expect(isValidTeamDomain(TEAM_DOMAIN)).toBe(true);
      expect(isValidTeamDomain(`https://${TEAM_DOMAIN}`)).toBe(false);
      expect(isValidTeamDomain(`${TEAM_DOMAIN}/`)).toBe(false);
      expect(isValidTeamDomain(`${TEAM_DOMAIN}:443`)).toBe(false);
      expect(isValidTeamDomain('localhost')).toBe(false);
      expect(isValidTeamDomain('')).toBe(false);
      expect(expectedIssuer(TEAM_DOMAIN)).toBe(`https://${TEAM_DOMAIN}`);
      expect(jwksUrl(TEAM_DOMAIN)).toBe(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
    });
  });

  describe('preHandler seam', () => {
    it('sets the perimeter principal on success and deletes the raw identity header', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const token = signToken(key.privateKey, { alg: 'RS256', kid: 'key-1' }, validPayload());
      const request = fakeRequest({
        'cf-access-jwt-assertion': token,
        'cf-access-authenticated-user-email': 'owner@example.invalid',
      });
      const preHandler = createCfAccessPreHandler(verifier);
      await preHandler(request, {} as never);
      expect(getCfAccessPrincipal(request)?.email).toBe('owner@example.invalid');
      expect(request.headers['cf-access-authenticated-user-email']).toBeUndefined();
    });

    it('throws the generic 401 on failure and still deletes the raw identity header', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const request = fakeRequest({
        'cf-access-authenticated-user-email': 'owner@example.invalid',
      });
      const preHandler = createCfAccessPreHandler(verifier);
      let caught: unknown;
      try {
        await preHandler(request, {} as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe('unauthenticated');
      expect((caught as ApiError).statusCode).toBe(401);
      expect(getCfAccessPrincipal(request)).toBeUndefined();
      expect(request.headers['cf-access-authenticated-user-email']).toBeUndefined();
    });

    it('never trusts the raw email header without a verified JWT', async () => {
      const key = makeKey('key-1');
      const { verifier } = makeVerifier(enabledConfig(), [{ keys: [key.jwk] }]);
      const other = makeKey('key-1');
      const forged = signToken(other.privateKey, { alg: 'RS256', kid: 'key-1' }, validPayload());
      const request = fakeRequest({
        'cf-access-jwt-assertion': forged,
        'cf-access-authenticated-user-email': 'owner@example.invalid',
      });
      const preHandler = createCfAccessPreHandler(verifier);
      await expect(preHandler(request, {} as never)).rejects.toBeInstanceOf(ApiError);
      expect(getCfAccessPrincipal(request)).toBeUndefined();
    });

    it('reads the JWT from its one canonical header only', () => {
      expect(readCfAccessJwtHeader(fakeRequest({ 'cf-access-jwt-assertion': 'token-value' }))).toBe('token-value');
      expect(readCfAccessJwtHeader(fakeRequest({}))).toBeUndefined();
      expect(readCfAccessJwtHeader(fakeRequest({ 'cf-access-jwt-assertion': '' }))).toBeUndefined();
      expect(
        readCfAccessJwtHeader(fakeRequest({ 'cf-access-jwt-assertion': ['a', 'b'] })),
      ).toBeUndefined();
    });
  });
});
