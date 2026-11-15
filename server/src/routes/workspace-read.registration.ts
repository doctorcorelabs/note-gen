// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Registration adapter for the workspace-read group (AD-61, hybrid
// registration). This file only moves the app.ts route block for
// this group into the adapter form; it changes no handler behavior.
//
// Routes declared by the registrar (kontrak 3.1, read side only):
//   GET  /api/workspace/list
//   GET  /api/workspace/file   (raw text, ETag revision)
//   HEAD /api/workspace/file   (same headers, no body, no 415/422)
//   GET  /api/workspace/scan
//   GET  /api/workspace/stat
// Write, move, trash, media, and reconcile routes belong to other
// groups and are deliberately absent here.
//
// Deps: the workspace root comes from config only. No AppDeps field
// is added: the revision workspace key defaults to the resolved
// root until the index worker injects the workspace UUID (desain
// assumption A1). Rank 40 keeps this group after auth (20) and
// before workspace-write (50), as in the frozen order (AD-40).

import type { RegistrationContext } from '../registration/context.js';
import { registerWorkspaceReadRoutes } from './workspace-read.js';

export const REGISTRATION_ID = 'workspace-read' as const;
export const REGISTRATION_ORDER = 40;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  await registerWorkspaceReadRoutes(ctx.app, {
    workspaceRoot: ctx.config.workspaceRoot,
  });
}
