// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the Fase 1 server configuration (desain-auth.md sections
// 2.1, 4.2, 7.2, 7.6, 13). Fase 0 config behavior (PORT, HOST, timeouts,
// DATABASE_URL and WORKSPACE_ROOT without silent defaults) is covered
// in health.spec.ts and is not repeated here, except where a Fase 1
// rule changes the outcome.
//
// Two rules pin the whole file: secret VALUES are never stored in the
// returned config and never appear in warnings, and fail-closed
// misconfigurations throw instead of starting with a silent fallback.
//
// File name note: the root .gitignore ignores "*.test.*", which would
// silently drop a file named config.test.ts from git. This file uses
// the .spec.ts suffix instead, which Vitest also picks up by default.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const LONG_SECRET = 'a'.repeat(40);
const SHORT_SECRET = 'too-short';

describe('registration mode', () => {
  it('defaults to closed', () => {
    expect(loadConfig({}).registrationMode).toBe('closed');
  });

  it('accepts the three known modes', () => {
    expect(loadConfig({ REGISTRATION_MODE: 'closed' }).registrationMode).toBe('closed');
    expect(loadConfig({ REGISTRATION_MODE: 'invitation' }).registrationMode).toBe('invitation');
    expect(loadConfig({ REGISTRATION_MODE: 'open' }).registrationMode).toBe('open');
  });

  it('refuses boot for an unrecognized mode instead of falling back', () => {
    expect(() => loadConfig({ REGISTRATION_MODE: 'public' })).toThrow(/REGISTRATION_MODE/);
    expect(() => loadConfig({ REGISTRATION_MODE: 'CLOSED' })).toThrow(/REGISTRATION_MODE/);
  });
});

describe('public base URL', () => {
  it('normalizes to the origin, dropping path and trailing slash', () => {
    const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost:3000/app/' });
    expect(config.publicBaseUrl).toBe('http://localhost:3000');
  });

  it('rejects a non-URL value and fails Origin checks closed', () => {
    const config = loadConfig({ PUBLIC_BASE_URL: 'not-a-url' });
    expect(config.publicBaseUrl).toBeUndefined();
    expect(config.warnings.join(' ')).toContain('PUBLIC_BASE_URL');
  });

  it('warns when production uses a non-HTTPS origin', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://example.invalid',
      CF_ACCESS_ENABLED: 'true',
      CF_ACCESS_AUD: 'aud',
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    });
    expect(config.warnings.join(' ')).toContain('PUBLIC_BASE_URL');
  });
});

describe('cookie secure flag', () => {
  it('defaults to true', () => {
    expect(loadConfig({}).cookieSecure).toBe(true);
  });

  it('allows false in development on localhost', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      COOKIE_SECURE: 'false',
      PUBLIC_BASE_URL: 'http://localhost:3000',
    });
    expect(config.cookieSecure).toBe(false);
  });

  it('allows false in development without a configured origin', () => {
    expect(loadConfig({ COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });

  it('refuses boot for false in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        COOKIE_SECURE: 'false',
        CF_ACCESS_ENABLED: 'true',
        CF_ACCESS_AUD: 'aud',
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it('refuses boot for false in development with a non-localhost origin', () => {
    expect(() =>
      loadConfig({
        COOKIE_SECURE: 'false',
        PUBLIC_BASE_URL: 'https://example.invalid',
      }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it('falls back to true with a warning for an unrecognized value', () => {
    const config = loadConfig({ COOKIE_SECURE: 'maybe' });
    expect(config.cookieSecure).toBe(true);
    expect(config.warnings.join(' ')).toContain('COOKIE_SECURE');
  });
});

describe('Cloudflare Access', () => {
  it('defaults to disabled in development without an origin', () => {
    const config = loadConfig({});
    expect(config.cfAccessEnabled).toBe(false);
  });

  it('refuses boot for an unrecognized value', () => {
    expect(() => loadConfig({ CF_ACCESS_ENABLED: 'yes' })).toThrow(/CF_ACCESS_ENABLED/);
  });

  it('refuses boot when enabled without an audience', () => {
    expect(() =>
      loadConfig({ CF_ACCESS_ENABLED: 'true', CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' }),
    ).toThrow(/CF_ACCESS_AUD/);
  });

  it('refuses boot when enabled without a team domain', () => {
    expect(() => loadConfig({ CF_ACCESS_ENABLED: 'true', CF_ACCESS_AUD: 'aud' })).toThrow(
      /CF_ACCESS_TEAM_DOMAIN/,
    );
  });

  it('accepts a complete enabled configuration', () => {
    const config = loadConfig({
      CF_ACCESS_ENABLED: 'true',
      CF_ACCESS_AUD: 'aud',
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_SERVICE_AUD: 'service-aud',
    });
    expect(config.cfAccessEnabled).toBe(true);
    expect(config.cfAccessAud).toBe('aud');
    expect(config.cfAccessTeamDomain).toBe('team.cloudflareaccess.com');
    expect(config.cfAccessServiceAud).toBe('service-aud');
  });

  it('refuses boot when disabled in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/CF_ACCESS_ENABLED/);
  });

  it('refuses boot when disabled in development with a non-localhost origin', () => {
    expect(() =>
      loadConfig({ CF_ACCESS_ENABLED: 'false', PUBLIC_BASE_URL: 'https://example.invalid' }),
    ).toThrow(/CF_ACCESS_ENABLED/);
  });

  it('allows disabled in development on localhost', () => {
    const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost:3000' });
    expect(config.cfAccessEnabled).toBe(false);
  });

  it('defaults the JWKS cache TTL and falls back with a warning when invalid', () => {
    expect(loadConfig({}).cfAccessJwksCacheTtlSeconds).toBe(3600);
    expect(loadConfig({ CF_ACCESS_JWKS_CACHE_TTL_SECONDS: '120' }).cfAccessJwksCacheTtlSeconds).toBe(120);
    const invalid = loadConfig({ CF_ACCESS_JWKS_CACHE_TTL_SECONDS: 'soon' });
    expect(invalid.cfAccessJwksCacheTtlSeconds).toBe(3600);
    expect(invalid.warnings.join(' ')).toContain('CF_ACCESS_JWKS_CACHE_TTL_SECONDS');
  });
});

describe('secret presence flags', () => {
  it('records only presence and length for AUTH_SECRET, never the value', () => {
    const configured = loadConfig({ AUTH_SECRET: LONG_SECRET });
    expect(configured.authSecretConfigured).toBe(true);
    expect(configured.authSecretLengthOk).toBe(true);
    expect(JSON.stringify(configured)).not.toContain(LONG_SECRET);

    const short = loadConfig({ AUTH_SECRET: SHORT_SECRET });
    expect(short.authSecretConfigured).toBe(true);
    expect(short.authSecretLengthOk).toBe(false);
    expect(short.warnings.join(' ')).toContain('AUTH_SECRET');

    const missing = loadConfig({});
    expect(missing.authSecretConfigured).toBe(false);
    expect(missing.authSecretLengthOk).toBe(false);
  });

  it('records only presence for SETUP_TOKEN, never the value', () => {
    const configured = loadConfig({ SETUP_TOKEN: LONG_SECRET });
    expect(configured.setupTokenConfigured).toBe(true);
    expect(configured.setupTokenLengthOk).toBe(true);
    expect(JSON.stringify(configured)).not.toContain(LONG_SECRET);
    expect(loadConfig({ SETUP_TOKEN: SHORT_SECRET }).setupTokenLengthOk).toBe(false);
  });

  it('accepts the canonical ENCRYPTION_KEY name', () => {
    const config = loadConfig({ ENCRYPTION_KEY: LONG_SECRET });
    expect(config.encryptionKeyConfigured).toBe(true);
    expect(JSON.stringify(config)).not.toContain(LONG_SECRET);
  });

  it('accepts the legacy SECRETS_ENCRYPTION_KEY alias with a warning', () => {
    const config = loadConfig({ SECRETS_ENCRYPTION_KEY: LONG_SECRET });
    expect(config.encryptionKeyConfigured).toBe(true);
    expect(config.warnings.join(' ')).toContain('ENCRYPTION_KEY');
    expect(JSON.stringify(config)).not.toContain(LONG_SECRET);
  });

  it('never puts a secret value in any warning', () => {
    const marker = 'MARKER_SECRET_9f27';
    const config = loadConfig({
      AUTH_SECRET: marker,
      SETUP_TOKEN: marker,
      ENCRYPTION_KEY: marker,
      // <user> placeholder keeps this marker-only fixture out of secret-scan's credential-DSN pattern; loadConfig treats DATABASE_URL as opaque.
      DATABASE_URL: `postgres://<user>:${marker}@localhost:5432/db`,
    });
    expect(config.warnings.join('\n')).not.toContain(marker);
  });
});

describe('trust proxy and body limit', () => {
  it('defaults TRUST_PROXY to false and warns on an unrecognized value', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    const invalid = loadConfig({ TRUST_PROXY: 'maybe' });
    expect(invalid.trustProxy).toBe(false);
    expect(invalid.warnings.join(' ')).toContain('TRUST_PROXY');
  });

  it('defaults the body limit to 1 MB', () => {
    expect(loadConfig({}).maxBodyBytes).toBe(1048576);
  });

  it('accepts a valid body limit and falls back with a warning when invalid', () => {
    expect(loadConfig({ BODY_LIMIT_BYTES: '65536' }).maxBodyBytes).toBe(65536);
    const invalid = loadConfig({ BODY_LIMIT_BYTES: 'huge' });
    expect(invalid.maxBodyBytes).toBe(1048576);
    expect(invalid.warnings.join(' ')).toContain('BODY_LIMIT_BYTES');
  });

  it('rejects a body limit above the hard cap', () => {
    const config = loadConfig({ BODY_LIMIT_BYTES: '104857601' });
    expect(config.maxBodyBytes).toBe(1048576);
  });
});

describe('JWT audience', () => {
  it('records the configured audience and leaves it undefined when unset', () => {
    expect(loadConfig({}).jwtAudience).toBeUndefined();
    expect(loadConfig({ JWT_AUDIENCE: 'notegen-web' }).jwtAudience).toBe('notegen-web');
  });
});
