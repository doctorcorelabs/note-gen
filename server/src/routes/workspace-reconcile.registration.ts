// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace reconcile registration adapter (AD-61; desain
// registrasi programatik section 3.3, rank 70). Wires the V3-05
// reconcile trigger registrar that had no production caller
// before W4-WIRE (HARNESS-5) plus the W4-WIRE status route (S5-Q5).
//
// Routes declared by this group (kontrak 3.1, desain 4.5):
// - POST /api/workspace/reconcile (routes/workspace-reconcile.ts)
// - GET /api/workspace/reconcile (routes/workspace-reconcile.ts)
//
// Deps: one ReconcileJobRegistry instance is created here and
// shared by both registrars, as the reconcile service requires.
// When DATABASE_URL is configured, a dedicated Drizzle handle
// supplies the Postgres index port and the session-to-workspace
// identity resolver (services/workspace/reconcile-index-pg.ts),
// and its close step is appended to the shared close registry.
// When no URL is configured, the index port and resolver stay
// absent: POST fails closed 503 per request (the registrar's
// designed behavior) while GET still answers status from the
// registry. No repair port is wired (see reconcile-index-pg.ts):
// scans report drift honestly with zero repairs.

import type { RegistrationContext } from '../registration/context.js';
import { createDb } from '../db/index.js';
import {
  createDrizzleReconcileIndexPort,
  createDrizzleWorkspaceIdentityResolver,
} from '../services/workspace/reconcile-index-pg.js';
import { ReconcileJobRegistry } from '../services/workspace/reconcile.js';
import {
  registerWorkspaceReconcileRoutes,
  registerWorkspaceReconcileStatusRoutes,
} from './workspace-reconcile.js';

export const REGISTRATION_ID = 'workspace-reconcile' as const;
export const REGISTRATION_ORDER = 70;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const registry = new ReconcileJobRegistry();
  const databaseUrl = ctx.config.databaseUrl;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    const handle = createDb(databaseUrl);
    ctx.close.append(async () => {
      await handle.close();
    });
    await registerWorkspaceReconcileRoutes(ctx.app, {
      workspaceRoot: ctx.config.workspaceRoot,
      resolveIdentity: createDrizzleWorkspaceIdentityResolver(handle.db),
      index: createDrizzleReconcileIndexPort(handle.db),
      registry,
    });
  } else {
    await registerWorkspaceReconcileRoutes(ctx.app, {
      workspaceRoot: ctx.config.workspaceRoot,
      registry,
    });
  }
  await registerWorkspaceReconcileStatusRoutes(ctx.app, { registry });
}
