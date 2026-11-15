// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Test-only Fastify app for the workspace write routes.
//
// buildApp wires the real V3-04a ports (V3-04b integration), so
// these tests build the instance manually from the same frozen
// plugin functions buildApp uses (request id, error handling, auth
// hooks) and register the write routes with the test doubles from
// workspace-test-ports.ts. The wiring mirrors app.ts exactly; only
// the injected verifiers and ports differ.

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
} from '../../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../../src/plugins/request-id.js';
import {
  registerWorkspaceWriteRoutes,
  type WorkspaceWriteRouteDeps,
} from '../../src/routes/workspace-write.js';
import { TEST_USER_ID, type TestPortsBundle } from './workspace-test-ports.js';

export const TEST_ORIGIN = 'https://app.example.invalid';
export const TEST_PRINCIPAL: SessionPrincipal = {
  userId: TEST_USER_ID,
  role: 'user',
  sessionId: 'good-session',
};

// Headers for an authenticated, CSRF-valid browser mutation.
export const AUTH_HEADERS = {
  cookie: 'notegen_session=good-session',
  origin: TEST_ORIGIN,
  'x-csrf-token': 'good-csrf',
} as const;

export async function buildWriteTestApp(
  bundle: TestPortsBundle,
  overrides: Partial<WorkspaceWriteRouteDeps> = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024 * 1024,
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, {
    verifySession: async ({ sessionId }) => (sessionId === 'good-session' ? TEST_PRINCIPAL : null),
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: TEST_ORIGIN,
  });
  await registerWorkspaceWriteRoutes(app, {
    ports: bundle.ports,
    resolveIdentity: bundle.resolveIdentity,
    ...overrides,
  });
  await app.ready();
  return app;
}

export function errorBody(res: { json(): unknown }): { code: string; details?: Record<string, unknown> } {
  const body = res.json() as { error: { code: string; details?: Record<string, unknown> } };
  return body.error;
}
