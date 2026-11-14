// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for POST /api/csp-reports (kontrak 3.11, V3-39b).
//
// What is pinned here: the route answers 204 with an empty body for a
// valid report sent with no session, no CSRF token, and no Origin,
// proving the auth-hook exemption (CSP_REPORT_PATH /
// isPublicNoSessionRequest) end to end under deny-by-default
// verifiers; broken shapes answer 400 with the error envelope and
// field names only, never echoed values; malformed JSON answers 400
// invalid_json; oversized bodies answer 413; rate limiting answers
// 429 with Retry-After and never logs the rejected report;
// sanitization is proven on the sanitized record itself (query
// strings, fragments, userinfo, Bearer tokens, key=value secrets,
// policy nonces, and unknown fields never survive); and no CSP
// header is set by this endpoint.
//
// File name note: the root .gitignore ignores "*.test.*", which would
// silently drop a file named csp-reports.test.ts from git. This file
// uses the .spec.ts suffix instead, which Vitest also picks up by
// default (same convention as the other server specs).

import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { registerAuthHooks } from '../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import {
  createCspReportRateLimiter,
  CSP_REPORT_BODY_LIMIT_BYTES,
  CSP_REPORT_MAX_SAMPLE_LOG_LENGTH,
  parseCspReportBody,
  redactSensitiveText,
  registerCspReportRoutes,
  sanitizeCspReportUrl,
  type SanitizedCspReport,
} from '../src/routes/csp-reports.js';

const SECRET_TOKEN = 'SECRET_TOKEN_VALUE_9f27d41a8c';
const LONG_TOKEN = 'a'.repeat(40);

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
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
    ...overrides,
  };
}

function legacyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'csp-report': {
      'document-uri': 'https://app.example.invalid/notes/a',
      referrer: 'https://app.example.invalid/',
      'violated-directive': 'script-src',
      'effective-directive': 'script-src',
      'original-policy': "script-src 'self'; report-uri /api/csp-reports",
      disposition: 'enforce',
      'blocked-uri': 'https://evil.example.invalid/x.js',
      'line-number': 12,
      'column-number': 3,
      'source-file': 'https://app.example.invalid/notes/a',
      'status-code': 200,
      'script-sample': 'alert(1)',
      ...overrides,
    },
  };
}

function reportingApiBody(overrides: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return [
    {
      type: 'csp-violation',
      age: 0,
      url: 'https://app.example.invalid/notes/a',
      body: {
        documentURL: 'https://app.example.invalid/notes/a',
        referrer: 'https://app.example.invalid/',
        violatedDirective: 'script-src',
        effectiveDirective: 'script-src',
        originalPolicy: "script-src 'self'",
        disposition: 'enforce',
        blockedURL: 'inline',
        lineNumber: 12,
        columnNumber: 3,
        sourceFile: 'https://app.example.invalid/notes/a',
        statusCode: 200,
        sample: 'alert(1)',
        ...overrides,
      },
    },
  ];
}

async function bareApp(captured: SanitizedCspReport[], maxReports = 2): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandling(app, { version: '0.39.2-fork.1' });
  registerAuthHooks(app, {});
  await registerCspReportRoutes(app, {
    rateLimiter: createCspReportRateLimiter({ maxReports, windowMs: 60000 }),
    reportSink: (report) => {
      captured.push(report);
    },
  });
  return app;
}

describe('parseCspReportBody: legacy shape', () => {
  it('accepts a valid legacy report and normalizes it to the canonical shape', () => {
    const parsed = parseCspReportBody(legacyBody());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.reports).toHaveLength(1);
    expect(parsed.reports[0]).toEqual({
      format: 'csp-report',
      documentUri: 'https://app.example.invalid/notes/a',
      referrer: 'https://app.example.invalid/',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      originalPolicy: "script-src 'self'; report-uri /api/csp-reports",
      disposition: 'enforce',
      blockedUri: 'https://evil.example.invalid/x.js',
      lineNumber: 12,
      columnNumber: 3,
      sourceFile: 'https://app.example.invalid/notes/a',
      statusCode: 200,
      sample: 'alert(1)',
    });
  });

  it('rejects a body without a csp-report wrapper', () => {
    const parsed = parseCspReportBody({ 'document-uri': 'https://app.example.invalid/' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.issues).toContainEqual({ field: 'body', issue: 'must be a CSP report object or an array of reports' });
  });

  it('rejects a report with no directive at all', () => {
    const parsed = parseCspReportBody(legacyBody({ 'violated-directive': undefined, 'effective-directive': undefined }));
    // JSON.stringify drops undefined; build the shape explicitly instead.
    const explicit = parseCspReportBody({
      'csp-report': { 'document-uri': 'https://app.example.invalid/notes/a' },
    });
    expect(parsed.ok).toBe(false);
    expect(explicit.ok).toBe(false);
    if (explicit.ok) {
      return;
    }
    expect(explicit.issues).toContainEqual({
      field: 'csp-report.violated-directive',
      issue: 'is required when effective-directive is absent',
    });
  });

  it('rejects wrong types and out of range numbers with field names', () => {
    const parsed = parseCspReportBody(legacyBody({ 'line-number': '12', 'status-code': 99999 }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.issues).toContainEqual({ field: 'csp-report.line-number', issue: 'must be an integer between 0 and 1000000' });
    expect(parsed.issues).toContainEqual({ field: 'csp-report.status-code', issue: 'must be an integer between 0 and 999' });
  });

  it('drops unknown fields instead of rejecting or logging them', () => {
    const parsed = parseCspReportBody(
      legacyBody({ 'x-secret-field': SECRET_TOKEN, 'unknown-future-field': 'whatever' }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const serialized = JSON.stringify(parsed.reports);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain('x-secret-field');
    expect(serialized).not.toContain('unknown-future-field');
  });
});

describe('parseCspReportBody: Reporting API shape', () => {
  it('accepts an array of reports', () => {
    const body = reportingApiBody();
    body.push(body[0]);
    const parsed = parseCspReportBody(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.reports).toHaveLength(2);
    expect(parsed.reports[0]?.format).toBe('reporting-api');
    expect(parsed.reports[0]?.blockedUri).toBe('inline');
  });

  it('accepts a single report object with a body', () => {
    const parsed = parseCspReportBody(reportingApiBody()[0]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.reports).toHaveLength(1);
  });

  it('uses the top-level url when body documentURL is missing', () => {
    const single = reportingApiBody()[0];
    const body = (single['body'] ?? {}) as Record<string, unknown>;
    delete body['documentURL'];
    const parsed = parseCspReportBody(single);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.reports[0]?.documentUri).toBe('https://app.example.invalid/notes/a');
  });

  it('rejects a non CSP report type', () => {
    const body = reportingApiBody();
    body[0]['type'] = 'deprecation';
    const parsed = parseCspReportBody(body);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.issues).toContainEqual({ field: '[0].type', issue: 'must be csp-violation' });
  });

  it('rejects empty arrays, oversized batches, and non-object bodies', () => {
    expect(parseCspReportBody([]).ok).toBe(false);
    expect(parseCspReportBody(Array.from({ length: 11 }, () => reportingApiBody()[0])).ok).toBe(false);
    expect(parseCspReportBody('not an object').ok).toBe(false);
    expect(parseCspReportBody(null).ok).toBe(false);
    expect(parseCspReportBody(42).ok).toBe(false);
  });
});

describe('sanitization', () => {
  it('strips query, fragment, and userinfo from URLs and keeps scheme, host, and path', () => {
    expect(sanitizeCspReportUrl(`https://user:pass@app.example.invalid/notes/a?token=${SECRET_TOKEN}#frag`)).toBe(
      'https://app.example.invalid/notes/a',
    );
    expect(sanitizeCspReportUrl('https://app.example.invalid/notes/a?x=1')).toBe('https://app.example.invalid/notes/a');
    expect(sanitizeCspReportUrl('inline')).toBe('inline');
    expect(sanitizeCspReportUrl('eval')).toBe('eval');
    expect(sanitizeCspReportUrl(`data:text/html,${SECRET_TOKEN}`)).toBe('data:');
    expect(sanitizeCspReportUrl('not a url at all :::')).toBe('[redacted]');
    expect(sanitizeCspReportUrl('')).toBe('[redacted]');
  });

  it('redacts long token-like path segments', () => {
    expect(sanitizeCspReportUrl(`https://app.example.invalid/reset/${LONG_TOKEN}`)).toBe(
      'https://app.example.invalid/reset/[redacted]',
    );
  });

  it('redacts Bearer tokens, key=value secrets, and policy nonces', () => {
    expect(redactSensitiveText(`Authorization: Bearer ${LONG_TOKEN}`)).toBe('Authorization: Bearer [redacted]');
    expect(redactSensitiveText(`token=${SECRET_TOKEN}&other=1`)).toBe('token=[redacted]&other=1');
    expect(redactSensitiveText(`api_key=${SECRET_TOKEN}`)).toBe('api_key=[redacted]');
    expect(redactSensitiveText(`script-src 'self' 'nonce-${LONG_TOKEN}'`)).toBe("script-src 'self' 'nonce-[redacted]'");
    expect(redactSensitiveText(`see ${LONG_TOKEN} here`)).toBe('see [redacted] here');
  });

  it('never lets a token-like payload survive in the sanitized report', () => {
    const parsed = parseCspReportBody(
      legacyBody({
        'document-uri': `https://app.example.invalid/notes/a?token=${SECRET_TOKEN}`,
        'blocked-uri': `https://evil.example.invalid/x?session=${SECRET_TOKEN}`,
        'original-policy': `script-src 'self' 'nonce-${LONG_TOKEN}'`,
        'script-sample': `fetch("/api/x", { headers: { Authorization: "Bearer ${LONG_TOKEN}" } }) // token=${SECRET_TOKEN}`,
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const serialized = JSON.stringify(parsed.reports);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(LONG_TOKEN);
    expect(serialized).not.toContain('token=');
    expect(parsed.reports[0]?.documentUri).toBe('https://app.example.invalid/notes/a');
  });

  it('truncates samples to the log cap', () => {
    const parsed = parseCspReportBody(legacyBody({ 'script-sample': 'x'.repeat(1000) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.reports[0]?.sample).toHaveLength(CSP_REPORT_MAX_SAMPLE_LOG_LENGTH);
  });
});

describe('createCspReportRateLimiter', () => {
  it('allows up to the max, denies the next, and reopens in a new window', () => {
    const limiter = createCspReportRateLimiter({ maxReports: 2, windowMs: 60000 });
    expect(limiter.check('10.0.0.1', 1000).allowed).toBe(true);
    expect(limiter.check('10.0.0.1', 2000).allowed).toBe(true);
    const denied = limiter.check('10.0.0.1', 3000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.check('10.0.0.1', 61000).allowed).toBe(true);
  });

  it('isolates IPs and bounds the tracked table', () => {
    const limiter = createCspReportRateLimiter({ maxReports: 1, windowMs: 60000, maxTrackedIps: 2 });
    expect(limiter.check('10.0.0.1', 1000).allowed).toBe(true);
    expect(limiter.check('10.0.0.2', 1000).allowed).toBe(true);
    expect(limiter.check('10.0.0.1', 2000).allowed).toBe(false);
    expect(limiter.check('10.0.0.3', 2000).allowed).toBe(true);
    expect(limiter.trackedIps()).toBe(2);
  });
});

describe('POST /api/csp-reports through buildApp', () => {
  it('answers 204 with an empty body and no session, no CSRF token, and no Origin', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-reports',
      payload: legacyBody(),
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['content-security-policy-report-only']).toBeUndefined();
    await app.close();
  });

  it('answers 204 for the Reporting API content type and the legacy content type', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const reporting = await app.inject({
      method: 'POST',
      url: '/api/csp-reports',
      headers: { 'content-type': 'application/reports+json' },
      payload: JSON.stringify(reportingApiBody()),
    });
    expect(reporting.statusCode).toBe(204);
    const legacy = await app.inject({
      method: 'POST',
      url: '/api/csp-reports',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify(legacyBody()),
    });
    expect(legacy.statusCode).toBe(204);
    await app.close();
  });

  it('answers 400 validation_failed for a broken shape, without echoing values', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-reports',
      payload: { 'csp-report': { 'document-uri': 42, 'leaked-value': SECRET_TOKEN } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: { code: string; details: { fields: unknown } } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('validation_failed');
    expect(JSON.stringify(body)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(body.error.details.fields)).toContain('csp-report.document-uri');
    await app.close();
  });

  it('answers 400 invalid_json for malformed JSON and for an empty body', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/csp-reports',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
    expect((malformed.json() as { error: { code: string } }).error.code).toBe('invalid_json');
    const empty = await app.inject({
      method: 'POST',
      url: '/api/csp-reports',
      headers: { 'content-type': 'application/csp-report' },
      payload: '',
    });
    expect(empty.statusCode).toBe(400);
    expect((empty.json() as { error: { code: string } }).error.code).toBe('invalid_json');
    await app.close();
  });

  it('answers 404 for GET on the report path', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const res = await app.inject({ method: 'GET', url: '/api/csp-reports' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('not_found');
    await app.close();
  });

  it('answers 413 payload_too_large for a body over the route limit', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-reports',
      payload: { 'csp-report': { 'document-uri': 'https://app.example.invalid/', 'script-sample': 'x'.repeat(CSP_REPORT_BODY_LIMIT_BYTES) } },
    });
    expect(res.statusCode).toBe(413);
    expect((res.json() as { error: { code: string } }).error.code).toBe('payload_too_large');
    await app.close();
  });

  it('rate limits at the production default: 30 allowed, then 429 with Retry-After', async () => {
    const app = await buildApp({ config: testConfig(), pool: null, version: '0.39.2-fork.1' });
    let lastOk = 0;
    for (let i = 0; i < 30; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/api/csp-reports', payload: legacyBody() });
      expect(res.statusCode).toBe(204);
      lastOk = i + 1;
    }
    expect(lastOk).toBe(30);
    const limited = await app.inject({ method: 'POST', url: '/api/csp-reports', payload: legacyBody() });
    expect(limited.statusCode).toBe(429);
    const body = limited.json() as { ok: boolean; error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.retryable).toBe(true);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });
});

describe('POST /api/csp-reports with a capturing sink', () => {
  it('records the sanitized report and nothing raw', async () => {
    const captured: SanitizedCspReport[] = [];
    const app = await bareApp(captured);
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-reports',
      payload: legacyBody({
        'document-uri': `https://app.example.invalid/notes/a?token=${SECRET_TOKEN}`,
        'x-secret-field': SECRET_TOKEN,
      }),
    });
    expect(res.statusCode).toBe(204);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.documentUri).toBe('https://app.example.invalid/notes/a');
    expect(JSON.stringify(captured)).not.toContain(SECRET_TOKEN);
    await app.close();
  });

  it('does not record rate-limited reports', async () => {
    const captured: SanitizedCspReport[] = [];
    const app = await bareApp(captured, 2);
    expect((await app.inject({ method: 'POST', url: '/api/csp-reports', payload: legacyBody() })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/csp-reports', payload: legacyBody() })).statusCode).toBe(204);
    const limited = await app.inject({ method: 'POST', url: '/api/csp-reports', payload: legacyBody() });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(captured).toHaveLength(2);
    await app.close();
  });
});
