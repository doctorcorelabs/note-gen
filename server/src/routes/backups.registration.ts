// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Registration adapter for the minimal backups group (AD-61; R24-DEC2E,
// AD-201 item 2A, rank 135). One route only; see routes/backups.ts for
// the full scope note and the kontrak 3.10 deviations.
//
// Routes declared by this group (via registerBackupRoutes, routes/backups.ts):
// - POST /api/backups/export (200 JSON workspace export download)
// The remaining kontrak 3.10 backup routes stay unregistered:
// create/list/get/download answer 404, jobs and download-token
// routes answer 404, and restore answers 501 from the stubs group
// (rank 140). Rank 135 keeps this group after assets (130) and
// before stubs (140); no route ordering hazard exists because no
// /api/backups/:id parameter route is registered.
// Deps: { workspaceRoot } from ctx.config.workspaceRoot, as in the
// workspace-read adapter. No AppDeps field is added.

import type { RegistrationContext } from '../registration/context.js';
import { registerBackupRoutes } from './backups.js';

export const REGISTRATION_ID = 'backups' as const;
export const REGISTRATION_ORDER = 135;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  await registerBackupRoutes(ctx.app, { workspaceRoot: ctx.config.workspaceRoot });
}
