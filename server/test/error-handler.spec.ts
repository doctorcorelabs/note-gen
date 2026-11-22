// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Not-found handler contract (W4-FAILCLOSED, finding F2): a wrong
// method on a known path answers 405 method_not_allowed (kontrak
// 6.2, retryable false), while an unknown path answers 404
// not_found. The unit cases pin the route-pattern matcher
// (literals, :param, trailing wildcard, trailing slash, case);
// the HTTP cases pin the split through the real buildApp
// (literal, :param, and media wildcard routes; the wildcard
// route is wired by the workspace-media adapter, rank 80,
// W4-WIRE).

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { pathMatchesRoutePattern, requestFailLogLevel } from '../src/plugins/error-handler.js';

describe('pathMatchesRoutePattern', () => {
  it('matches exact literal paths only', () => {
    expect(pathMatchesRoutePattern('/api/settings', '/api/settings')).toBe(true);
    expect(pathMatchesRoutePattern('/api/settings', '/api/settings/')).toBe(false);
    expect(pathMatchesRoutePattern('/api/settings', '/api/Settings')).toBe(false);
    expect(pathMatchesRoutePattern('/api/settings', '/api/setting')).toBe(false);
    expect(pathMatchesRoutePattern('/api/settings', '/api/settings/extra')).toBe(false);
  });

  it('matches a :param segment against exactly one non-empty segment', () => {
    expect(pathMatchesRoutePattern('/api/auth/sessions/:id', '/api/auth/sessions/abc')).toBe(true);
    expect(pathMatchesRoutePattern('/api/auth/sessions/:id', '/api/auth/sessions/')).toBe(false);
    expect(pathMatchesRoutePattern('/api/auth/sessions/:id', '/api/auth/sessions/a/b')).toBe(false);
    expect(pathMatchesRoutePattern('/api/auth/sessions/:id', '/api/auth/sessions')).toBe(false);
    expect(
      pathMatchesRoutePattern(
        '/api/settings/secrets/ai-providers/:providerKey',
        '/api/settings/secrets/ai-providers/acme',
      ),
    ).toBe(true);
  });

  it('matches a trailing wildcard against one or more remaining segments', () => {
    expect(pathMatchesRoutePattern('/api/workspace/media/*', '/api/workspace/media/a.png')).toBe(true);
    expect(pathMatchesRoutePattern('/api/workspace/media/*', '/api/workspace/media/a/b.png')).toBe(true);
    expect(pathMatchesRoutePattern('/api/workspace/media/*', '/api/workspace/media/')).toBe(true);
    expect(pathMatchesRoutePattern('/api/workspace/media/*', '/api/workspace/media')).toBe(false);
    expect(pathMatchesRoutePattern('/api/workspace/media/*', '/api/workspace/other/a.png')).toBe(false);
  });

  it('decodes percent-encoded segments before comparing', () => {
    expect(pathMatchesRoutePattern('/api/auth/sessions/:id', '/api/auth/sessions/a%20b')).toBe(true);
    expect(pathMatchesRoutePattern('/api/workspace/list', '/api/workspace/list')).toBe(true);
  });
});

describe('requestFailLogLevel', () => {
  it('logs server errors at error regardless of code', () => {
    expect(requestFailLogLevel('internal_error', 500)).toBe('error');
    expect(requestFailLogLevel('revision_conflict', 500)).toBe('error');
  });

  it('logs an expected revision_conflict at info (IM-7 F10-03)', () => {
    expect(requestFailLogLevel('revision_conflict', 409)).toBe('info');
    expect(requestFailLogLevel('revision_conflict', 412)).toBe('info');
  });

  it('keeps other client errors at warn', () => {
    expect(requestFailLogLevel('not_found', 404)).toBe('warn');
    expect(requestFailLogLevel('validation_failed', 400)).toBe('warn');
  });
});

describe('not-found handler over HTTP', () => {
  function testConfig(): ServerConfig {
    return {
      host: '127.0.0.1',
      port: 3001,
      databaseUrl: 'postgres://placeholder/placeholder',
      workspaceRoot: '/tmp',
      nodeEnv: 'development',
      logLevel: 'silent',
      checkTimeoutMs: 2000,
      overallTimeoutMs: 5000,
      warnings: [],
      registrationMode: 'closed',
      publicBaseUrl: undefined,
      trustProxy: false,
      cookieSecure: true,
      cfAccessEnabled: false,
      cfAccessTeamDomain: undefined,
      cfAccessAud: undefined,
      cfAccessServiceAud: undefined,
      cfAccessJwksCacheTtlSeconds: 3600,
      jwtAudience: undefined,
      authSecretConfigured: false,
      authSecretLengthOk: false,
      encryptionKeyConfigured: false,
      setupTokenConfigured: false,
      setupTokenLengthOk: false,
      maxBodyBytes: 1048576,
    };
  }

  it('answers 405 for a wrong method on literal and :param paths', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: 'test' });
    try {
      for (const target of [
        { method: 'DELETE', url: '/api/workspace/list' },
        { method: 'GET', url: '/api/settings/secrets/ai-providers/acme' },
      ] as const) {
        const res = await app.inject({ method: target.method, url: target.url });
        expect(res.statusCode).toBe(405);
        const body = res.json() as { ok: boolean; error: Record<string, unknown> };
        expect(body.ok).toBe(false);
        expect(body.error['code']).toBe('method_not_allowed');
        expect(body.error['retryable']).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  it('answers 405 for a wrong method on the media wildcard route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'w4fc-media-'));
    const app = await buildApp({
      config: { ...testConfig(), workspaceRoot: dir },
      pool: null,
      version: 'test',
    });
    try {
      for (const url of ['/api/workspace/media/pic.png', '/api/workspace/media/a/b.png']) {
        const res = await app.inject({ method: 'POST', url });
        expect(res.statusCode).toBe(405);
        const body = res.json() as { ok: boolean; error: Record<string, unknown> };
        expect(body.ok).toBe(false);
        expect(body.error['code']).toBe('method_not_allowed');
        expect(body.error['retryable']).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  it('answers 404 for unknown paths, trailing-slash variants, and case variants', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: 'test' });
    try {
      for (const url of ['/api/nope', '/api/workspace/list/', '/API/workspace/list']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(404);
        const body = res.json() as { ok: boolean; error: Record<string, unknown> };
        expect(body.error['code']).toBe('not_found');
      }
    } finally {
      await app.close();
    }
  });
});
