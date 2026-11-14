// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Health routes: GET /api/health/live, GET /api/health/ready, and
// GET /api/health as an alias that uses the exact same ready handler,
// never a second copy of the logic.
//
// - Liveness proves only that the process answers. Its handler is
//   synchronous, memory-only, and never touches the database, the
//   workspace disk, or any other service. The only failure mode for
//   liveness is no response at all.
// - Readiness proves the backend is ready to serve: Postgres plus the
//   workspace, with the reported checks from checks.ts. A failed hard
//   check means HTTP 503 with ok false. HTTP 200 with ok false and
//   HTTP 503 with ok true are both forbidden and treated as bugs.
// - No application auth applies to these three paths. Orchestrator
//   probes and container healthchecks carry no credentials, and a 401
//   from the API itself would break the watchdog diagnosis that
//   distinguishes edge credential problems from origin failures. The
//   Cloudflare Access perimeter still guards public probes.
// - Responses are never cached: Cache-Control no-store on every health
//   response.
// - Health keeps its Fase 0 envelope shape (ok, status, service,
//   version, uptimeSeconds, timestamp, checks). It does NOT use the
//   generic { ok, data } / { ok, error } envelope: the response schemas
//   forbid extra body fields. The request id travels only via the
//   X-Request-Id response header. The routes declare requiresAuth:
//   false explicitly so the global auth hook skips them by config as
//   well as by the health path exemption.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { HealthDbPool } from '../db/pool.js';
import {
  checkWorker,
  runReadyChecks,
  type CheckResult,
  type ReadyChecks,
  type WorkspaceFs,
} from '../health/checks.js';
import { liveResponseSchema, readyResponseSchema } from '../health/schemas.js';

// Single source of truth for the health paths. The error handler and
// the auth hook import this list; a path added here is public and
// covered by the emergency-envelope safety net, and a path removed
// here loses both. Keep the registrations below on these constants.
export const HEALTH_LIVE_PATH = '/api/health/live';
export const HEALTH_READY_PATH = '/api/health/ready';
export const HEALTH_ALIAS_PATH = '/api/health';
export const HEALTH_PATHS: readonly string[] = [HEALTH_LIVE_PATH, HEALTH_READY_PATH, HEALTH_ALIAS_PATH];

export interface HealthRouteDeps {
  pool: HealthDbPool | null;
  workspaceRoot: string | undefined;
  version: string;
  checkTimeoutMs: number;
  overallTimeoutMs: number;
  workspaceFs?: WorkspaceFs;
}

export interface HealthEnvelope {
  ok: boolean;
  status: 'live' | 'ready' | 'not_ready';
  service: 'note-gen-web-api';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: Record<string, CheckResult>;
}

function uptimeSeconds(): number {
  return Math.max(0, Math.floor(process.uptime()));
}

function timestamp(): string {
  return new Date().toISOString();
}

export function buildLiveEnvelope(version: string): HealthEnvelope {
  return {
    ok: true,
    status: 'live',
    service: 'note-gen-web-api',
    version,
    uptimeSeconds: uptimeSeconds(),
    timestamp: timestamp(),
    checks: {
      process: { status: 'ok', latencyMs: 0, detail: 'process_responding', error: null },
    },
  };
}

// Emergency envelope for an unexpected error inside the ready handler.
// The worker result is a known constant (always skipped in Fase 0), so
// it keeps its honest value; every other check reports the handler
// error code. No stack trace and no raw error message ever enters the
// body.
export function buildEmergencyEnvelope(version: string): HealthEnvelope {
  const failed: CheckResult = { status: 'fail', latencyMs: null, detail: 'handler_error', error: 'HEALTH_HANDLER_ERROR' };
  const checks: ReadyChecks = {
    db: failed,
    workspace: failed,
    migrations: failed,
    pgvector: failed,
    worker: checkWorker(),
  };
  return {
    ok: false,
    status: 'not_ready',
    service: 'note-gen-web-api',
    version,
    uptimeSeconds: uptimeSeconds(),
    timestamp: timestamp(),
    checks,
  };
}

function setHealthHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Type', 'application/json; charset=utf-8');
}

export async function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): Promise<void> {
  app.get(
    HEALTH_LIVE_PATH,
    { schema: { response: { 200: liveResponseSchema } }, config: { requiresAuth: false } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      setHealthHeaders(reply);
      return buildLiveEnvelope(deps.version);
    },
  );

  const readyHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<HealthEnvelope> => {
    setHealthHeaders(reply);
    try {
      const { checks, ok } = await runReadyChecks({
        pool: deps.pool,
        workspaceRoot: deps.workspaceRoot,
        checkTimeoutMs: deps.checkTimeoutMs,
        overallTimeoutMs: deps.overallTimeoutMs,
        workspaceFs: deps.workspaceFs,
      });
      for (const [name, check] of Object.entries(checks)) {
        if (check.status === 'fail') {
          // Log only the check name, the machine error code, and the
          // latency. Never the raw driver message or any config value.
          request.log.warn({ check: name, error: check.error, latencyMs: check.latencyMs }, 'health check failed');
        }
      }
      reply.code(ok ? 200 : 503);
      return {
        ok,
        status: ok ? 'ready' : 'not_ready',
        service: 'note-gen-web-api',
        version: deps.version,
        uptimeSeconds: uptimeSeconds(),
        timestamp: timestamp(),
        checks,
      };
    } catch {
      request.log.error({ code: 'HEALTH_HANDLER_ERROR' }, 'health handler error');
      reply.code(503);
      return buildEmergencyEnvelope(deps.version);
    }
  };

  const readyOptions = {
    schema: { response: { 200: readyResponseSchema, 503: readyResponseSchema } },
    config: { requiresAuth: false },
  };
  app.get(HEALTH_READY_PATH, readyOptions, readyHandler);
  app.get(HEALTH_ALIAS_PATH, readyOptions, readyHandler);
}
