// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture adapter for check-registration-order.mjs (positive case):
// well-formed contract, rank 40, gap ranks are legal.

import type { RegistrationContext } from '../registration/context.js';
import { registerWorkspaceReadRoutes } from './workspace-read.js';

export const REGISTRATION_ID = 'workspace-read' as const;
export const REGISTRATION_ORDER = 40;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  await registerWorkspaceReadRoutes(ctx.app, { workspaceRoot: ctx.workspaceRoot });
}
