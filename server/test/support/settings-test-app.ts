// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Test app factory for the settings/secrets routes. It composes the
// SAME frozen plugins as buildApp (request ids, error handling, auth
// hooks) but registers the settings routes with injected service deps,
// because buildApp wires the production store/cipher and Fastify
// forbids registering the same paths twice. The production wiring in
// app.ts is covered separately by the buildApp smoke tests in
// settings-routes.spec.ts (deny-by-default + fail-closed store).
//
// Auth stubs: the session verifier returns a fixed principal for any
// request (tests that need denial pass their own verifier); CSRF
// passes only for the fixed test token; Origin uses the production
// matcher against the test canonical origin.

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import {
  registerAuthHooks,
  type SessionPrincipal,
  type VerifyCsrfTokenFn,
  type VerifySessionFn,
} from '../../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../../src/plugins/error-handler.js';
import { buildLoggerOptions } from '../../src/plugins/logging.js';
import { registerRequestId, requestIdFromHeaders } from '../../src/plugins/request-id.js';
import { registerSecretsRoutes } from '../../src/routes/secrets.js';
import { registerSettingsRoutes } from '../../src/routes/settings.js';
import type { SettingsServiceDeps } from '../../src/services/settings/settings-service.js';

export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_ORIGIN = 'http://localhost:3001';
export const TEST_CSRF_TOKEN = 'good-csrf-token';

export const SESSION_HEADERS: Record<string, string> = {
  cookie: 'notegen_session=test-session',
};

export const MUTATION_HEADERS: Record<string, string> = {
  ...SESSION_HEADERS,
  origin: TEST_ORIGIN,
  'x-csrf-token': TEST_CSRF_TOKEN,
};

export const TEST_PRINCIPAL: SessionPrincipal = {
  credentialEpoch: 0,
  role: 'user',
  sessionId: 'test-session',
  userId: TEST_USER_ID,
};

export const allowSession: VerifySessionFn = async () => TEST_PRINCIPAL;
export const denySession: VerifySessionFn = async () => null;
export const testVerifyCsrf: VerifyCsrfTokenFn = async (request) =>
  request.headers['x-csrf-token'] === TEST_CSRF_TOKEN;

export interface TestAppOptions {
  verifySession?: VerifySessionFn;
  verifyCsrf?: VerifyCsrfTokenFn;
}

export async function createSettingsTestApp(
  deps: SettingsServiceDeps,
  options: TestAppOptions = {},
): Promise<FastifyInstance> {
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    NODE_ENV: 'development',
    PUBLIC_BASE_URL: TEST_ORIGIN,
  });
  const app = Fastify({
    bodyLimit: config.maxBodyBytes,
    genReqId: (request) => requestIdFromHeaders(request.headers),
    logController: new LogController({ disableRequestLogging: true }),
    logger: buildLoggerOptions(config.logLevel),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, {
    canonicalOrigin: config.publicBaseUrl,
    verifyCsrf: options.verifyCsrf ?? testVerifyCsrf,
    verifySession: options.verifySession ?? allowSession,
  });
  await registerSettingsRoutes(app, deps);
  await registerSecretsRoutes(app, deps);
  await app.ready();
  return app;
}

// Production buildApp, for smoke tests of the app.ts settings block:
// the block registers the routes with production deps (lazy database,
// fail-closed cipher), so without DATABASE_URL the routes answer 503
// after auth, and without verifiers they answer 401.
export async function createProductionTestApp(): Promise<FastifyInstance> {
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    NODE_ENV: 'development',
    PUBLIC_BASE_URL: TEST_ORIGIN,
  });
  const app = await buildApp({
    config,
    pool: null,
    verifyCsrf: testVerifyCsrf,
    verifySession: allowSession,
    version: 'test',
  });
  await app.ready();
  return app;
}
