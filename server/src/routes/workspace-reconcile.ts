// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace reconcile routes (V3-05 part 4, wave 3B overlap, plus
// the W4-WIRE status route): POST /api/workspace/reconcile (trigger)
// and GET /api/workspace/reconcile (status + last report). Both
// registrars share one ReconcileJobRegistry instance supplied by
// the reconcile registration adapter (rank 70); the GET route
// reads the registry the POST route writes, so the two must never
// receive different instances.
//
// Contract: kontrak-api-kanonis.md section 3.1 with the semantics
// of desain-workspace-api.md section 4.5. Request JSON
// `{ full, dryRun }`, both optional booleans; `full` defaults to
// true and is the only mode in MVP, so `full: false` answers 400
// validation_failed; `dryRun` defaults to false. Unknown body
// fields (including workspaceId, kontrak 1.1) answer 400
// validation_failed with details.fields (kontrak K-09). Success
// is 202 with the canonical envelope carrying
// `{ jobId, status: "running", full, dryRun, startedAt }` in ISO
// 8601 UTC. A second POST while a run is in flight answers 409
// reconcile_already_running and never queues.
//
// Auth, CSRF, and Origin are enforced by the frozen global hook
// (middleware/auth-hook.ts); this route only declares
// requiresAuth. The handler answers 202 as soon as the job is
// claimed and runs the scan in the background: it never awaits
// the scan, so a slow vault cannot hold the request open.
//
// Fail-closed wiring: when no index port, no workspace root, or
// no identity resolver is injected, the POST handler answers 503
// service_unavailable after auth passes, exactly like the write
// routes behave without ports. No fake index is ever consulted:
// with no index, every disk file would look like orphan drift.
// The reconcile adapter wires the real V3-06 index port and the
// session-to-workspace resolver by passing them to
// registerWorkspaceReconcileRoutes, and MUST pass one shared
// ReconcileJobRegistry instance to both this route and the GET
// status route (see services/workspace/reconcile.ts). No repair
// port is wired in MVP: scans report drift honestly with zero
// repairs, and driftRemaining equals driftFound until a repair
// slice lands.
//
// GET status semantics (desain-workspace-api.md section 4.5):
// `lastRun` is the newest completed report, or null when no scan
// has completed (a failed tail does not erase the last completed
// report). `driftWarning` follows the alert table: 5 or more
// remaining drift entries, or 1 percent or more of scanned files.
// `driftCritical` follows the same table: 50 or more remaining
// entries, 5 percent or more, the same path drifting in two
// consecutive full scans, or two total job failures in a row.
// `watcherDegraded` is true in MVP because no filesystem watcher
// is installed: polling is the live change path, which is the
// degraded watching mode by definition (desain 9.6). It must
// become watcher-health-driven when a watcher lands.
// `nextScheduledRunAt` is null in MVP because no periodic scan
// scheduler exists (the 15-minute scan is infra work, desain
// section 4.5 table, assumption A9); a null states that no run
// is scheduled rather than inventing a time.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import {
  fieldError,
  rejectUnknownFields,
  requireJsonObject,
} from '../services/workspace/write-guards.js';
import type { WorkspaceIdentityResolver } from '../services/workspace/write-ports.js';
import {
  ReconcileJobRegistry,
  createReconcileJobId,
  runReconcileScan,
  type ReconcileIndexPort,
  type ReconcileRepairPort,
  type ReconcileReport,
} from '../services/workspace/reconcile.js';

export const RECONCILE_PATH = '/api/workspace/reconcile';

// Workspace JSON body limit from the contract catalog (kontrak 6.2:
// 64 KiB for workspace endpoints).
export const RECONCILE_BODY_LIMIT_BYTES = 64 * 1024;

export interface WorkspaceReconcileRouteDeps {
  workspaceRoot?: string;
  resolveIdentity?: WorkspaceIdentityResolver;
  index?: ReconcileIndexPort;
  repairs?: ReconcileRepairPort;
  registry?: ReconcileJobRegistry;
}

interface ReconcileRequestOptions {
  full: boolean;
  dryRun: boolean;
}

// An absent body means defaults: both fields are optional, so a
// POST with no payload is the same as `{}`. A present body must be
// a JSON object; arrays, null, and scalars answer invalid_json,
// and malformed JSON is caught by the global error handler before
// this code runs (AD-46).
function parseReconcileBody(body: unknown): ReconcileRequestOptions {
  const record = body === undefined ? {} : requireJsonObject(body);
  rejectUnknownFields(record, ['full', 'dryRun']);
  const full = record['full'];
  if (full !== undefined && typeof full !== 'boolean') {
    throw fieldError('full', 'expected a boolean');
  }
  if (full === false) {
    throw fieldError('full', 'only full scans are supported');
  }
  const dryRun = record['dryRun'];
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw fieldError('dryRun', 'expected a boolean');
  }
  return { full: true, dryRun: dryRun === true };
}

export async function registerWorkspaceReconcileRoutes(
  app: FastifyInstance,
  deps: WorkspaceReconcileRouteDeps,
): Promise<void> {
  const registry = deps.registry ?? new ReconcileJobRegistry();

  app.post(
    RECONCILE_PATH,
    { config: { requiresAuth: true }, bodyLimit: RECONCILE_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (
        deps.index === undefined ||
        deps.workspaceRoot === undefined ||
        deps.workspaceRoot === '' ||
        deps.resolveIdentity === undefined
      ) {
        throw ApiError.serviceUnavailable();
      }
      const index = deps.index;
      const workspaceRoot = deps.workspaceRoot;
      const resolveIdentity = deps.resolveIdentity;
      const options = parseReconcileBody(request.body);
      const principal = getPrincipal(request);
      if (principal === undefined) {
        throw ApiError.serviceUnavailable();
      }
      const identity = await resolveIdentity(principal);
      if (identity === null) {
        throw ApiError.serviceUnavailable();
      }
      const startedAt = new Date();
      const jobId = createReconcileJobId();
      const claimed = registry.tryStart(jobId, options.full, options.dryRun, startedAt);
      if (claimed === null) {
        throw new ApiError(409, 'reconcile_already_running', 'A reconciliation is already running.');
      }
      // Fire and forget, with the outcome recorded on the registry.
      // The promise never rejects outward: runReconcileScan errors
      // mark the job failed instead of surfacing as an unhandled
      // rejection after the 202 has been sent.
      void (async () => {
        try {
          const report = await runReconcileScan({
            jobId,
            workspaceId: identity.workspaceId,
            workspaceRoot,
            index,
            repairs: deps.repairs,
            dryRun: options.dryRun,
            startedAt,
          });
          registry.complete(jobId, report);
        } catch {
          registry.fail(jobId, new Date());
          request.log.error({ jobId }, 'reconciliation job failed');
        }
      })();
      reply.code(202);
      reply.send(
        successEnvelope({
          jobId,
          status: 'running',
          full: options.full,
          dryRun: options.dryRun,
          startedAt: startedAt.toISOString(),
        }),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// GET status route (W4-WIRE)
// ---------------------------------------------------------------------------

export interface ReconcileStatusResponse {
  running: boolean;
  lastRun: ReconcileReport | null;
  driftWarning: boolean;
  driftCritical: boolean;
  watcherDegraded: boolean;
  nextScheduledRunAt: string | null;
}

const DRIFT_WARNING_COUNT = 5;
const DRIFT_WARNING_RATIO = 0.01;
const DRIFT_CRITICAL_COUNT = 50;
const DRIFT_CRITICAL_RATIO = 0.05;
const DRIFT_CRITICAL_FAILURE_STREAK = 2;

// Pure status computation over the shared registry, so the alert
// rules are unit-testable without HTTP. Thresholds are the desain
// 4.5 alert table, applied to driftRemaining (post-repair drift;
// with no repair port wired, equal to driftFound). The
// same-path-in-two-scans rule compares the driftPaths of the two
// newest completed reports; driftPaths is capped at 100 entries,
// so the comparison is over the reported prefix, which is the
// only drift evidence the status surface keeps.
export function computeReconcileStatus(registry: ReconcileJobRegistry): ReconcileStatusResponse {
  const running = registry.running() !== null;
  const lastRun = registry.lastCompletedReport();
  let driftWarning = false;
  let driftCritical = false;
  if (lastRun !== null) {
    const ratio = lastRun.filesScanned > 0 ? lastRun.driftRemaining / lastRun.filesScanned : 0;
    driftWarning =
      lastRun.driftRemaining >= DRIFT_WARNING_COUNT || ratio >= DRIFT_WARNING_RATIO;
    const completed = registry
      .finishedHistory()
      .filter((record) => record.status === 'completed' && record.report !== null);
    const previous = completed[1]?.report ?? null;
    const repeatedPath =
      previous !== null &&
      lastRun.driftPaths.some((path) => previous.driftPaths.includes(path));
    driftCritical =
      lastRun.driftRemaining >= DRIFT_CRITICAL_COUNT ||
      ratio >= DRIFT_CRITICAL_RATIO ||
      repeatedPath;
  }
  if (registry.consecutiveFailures() >= DRIFT_CRITICAL_FAILURE_STREAK) {
    driftCritical = true;
  }
  return {
    running,
    lastRun,
    driftWarning,
    driftCritical,
    // No filesystem watcher is installed in MVP (see the module
    // header): watching runs degraded, through polling.
    watcherDegraded: true,
    // No periodic scheduler exists in MVP (see the module header).
    nextScheduledRunAt: null,
  };
}

export interface WorkspaceReconcileStatusRouteDeps {
  registry: ReconcileJobRegistry;
}

export async function registerWorkspaceReconcileStatusRoutes(
  app: FastifyInstance,
  deps: WorkspaceReconcileStatusRouteDeps,
): Promise<void> {
  app.get(
    RECONCILE_PATH,
    { config: { requiresAuth: true } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.send(successEnvelope(computeReconcileStatus(deps.registry)));
    },
  );
}
