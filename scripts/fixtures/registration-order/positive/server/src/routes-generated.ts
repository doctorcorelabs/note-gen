// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture generated index for check-registration-order.mjs (positive
// case). Hand-written to the generated shape; not real generator
// output. Call order matches adapter rank order.

import type { RegistrationContext } from './registration/context.js';
import { registerGroup as registerHealthGroup } from './routes/health.registration.js';
import { registerGroup as registerWorkspaceReadGroup } from './routes/workspace-read.registration.js';

export async function registerRouteGroups(ctx: RegistrationContext): Promise<void> {
  // 10 health
  await registerHealthGroup(ctx);
  // 40 workspace-read
  await registerWorkspaceReadGroup(ctx);
}
