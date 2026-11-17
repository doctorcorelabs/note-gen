// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace structure registration adapter (AD-61; desain
// registrasi programatik section 3.3, rank 60). Wires the three
// V3-05 structure registrars that had no production caller before
// W4-WIRE (HARNESS-5): mkdir, move, and trash.
//
// Routes declared by this group (kontrak 3.1):
// - POST /api/workspace/mkdir (routes/workspace-mkdir.ts)
// - POST /api/workspace/move (routes/workspace-move.ts)
// - POST /api/workspace/move/repair-links (routes/workspace-move.ts)
// - DELETE /api/workspace/file (routes/workspace-trash.ts)
// - DELETE /api/workspace/folder (routes/workspace-trash.ts)
// - GET /api/workspace/trash (routes/workspace-trash.ts)
// - POST /api/workspace/trash (routes/workspace-trash.ts)
// - POST /api/workspace/trash/:id/restore (routes/workspace-trash.ts)
// - DELETE /api/workspace/trash/:id (routes/workspace-trash.ts)
// - DELETE /api/workspace/trash (routes/workspace-trash.ts)
//
// Deps: the workspace root comes from config only. The trash
// root comes from config.trashRoot when set (TRASH_ROOT); when
// unset, the trash registrar derives its sibling default from
// the resolved root (desain-workspace-api.md section 5.1). Move
// idempotency is NOT wired here: no idempotency store or identity
// resolver is passed, so Idempotency-Key headers on move requests
// are accepted and ignored, exactly as the registrar behaves
// with those deps omitted. Wiring a durable move idempotency
// store is a follow-up; the in-memory store used by the move
// spec is test-only and must never be wired into production.

import type { RegistrationContext } from '../registration/context.js';
import { registerWorkspaceMkdirRoutes } from './workspace-mkdir.js';
import { registerWorkspaceMoveRoutes } from './workspace-move.js';
import { registerWorkspaceTrashRoutes } from './workspace-trash.js';

export const REGISTRATION_ID = 'workspace-structure' as const;
export const REGISTRATION_ORDER = 60;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  await registerWorkspaceMkdirRoutes(ctx.app, {
    workspaceRoot: ctx.config.workspaceRoot,
  });
  await registerWorkspaceMoveRoutes(ctx.app, {
    workspaceRoot: ctx.config.workspaceRoot,
  });
  await registerWorkspaceTrashRoutes(ctx.app, {
    workspaceRoot: ctx.config.workspaceRoot,
    ...(ctx.config.trashRoot !== undefined ? { trashRoot: ctx.config.trashRoot } : {}),
  });
}
