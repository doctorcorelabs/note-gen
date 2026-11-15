// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture adapter for check-registration-order.mjs (negative case):
// rank 20, clashing with the workspace-read adapter. The checker
// must report a C-2 rank clash naming rank 20.

import type { RegistrationContext } from '../registration/context.js';
import { registerWorkspaceWriteRoutes } from './workspace-write.js';

export const REGISTRATION_ID = 'workspace-write' as const;
export const REGISTRATION_ORDER = 20;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  await registerWorkspaceWriteRoutes(ctx.app, { workspaceRoot: ctx.workspaceRoot });
}
