// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace reconcile trigger route (V3-05 part 4, wave 3B overlap):
// POST /api/workspace/reconcile only. The GET status route is a
// separate V3-05 part and is deliberately absent here.
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
// no identity resolver is injected, the handler answers 503
// service_unavailable after auth passes, exactly like the write
// routes behave without ports. No fake index is ever consulted:
// with no index, every disk file would look like orphan drift.
// The integrator wires the real V3-06 index port, the repair
// port, and the session-to-workspace resolver by passing them to
// registerWorkspaceReconcileRoutes, and MUST pass one shared
// ReconcileJobRegistry instance to both this route and the future
// GET status route (see services/workspace/reconcile.ts). No
// other file changes. This route is NOT registered in app.ts by
// this slice; registration is the integrator's step, in the
// workspace block, in contract order (AD-40).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrincipal } from '../../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../../plugins/envelope.js';
import {
  fieldError,
  rejectUnknownFields,
  requireJsonObject,
} from '../../services/workspace/write-guards.js';
import type { WorkspaceIdentityResolver } from '../../services/workspace/write-ports.js';
import {
  ReconcileJobRegistry,
  createReconcileJobId,
  runReconcileScan,
  type ReconcileIndexPort,
  type ReconcileRepairPort,
} from '../../services/workspace/reconcile.js';

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
