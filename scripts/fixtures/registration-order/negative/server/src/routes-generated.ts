// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture generated index for check-registration-order.mjs (negative
// case). Hand-written to the generated shape; not real generator
// output. Call order follows the (order, id) rank order, so the
// only failures in this tree are the rank clash and the duplicate
// route, not the index order.

import type { RegistrationContext } from './registration/context.js';
import { registerGroup as registerHealthGroup } from './routes/health.registration.js';
import { registerGroup as registerWorkspaceReadGroup } from './routes/workspace-read.registration.js';
import { registerGroup as registerWorkspaceWriteGroup } from './routes/workspace-write.registration.js';

export async function registerRouteGroups(ctx: RegistrationContext): Promise<void> {
  // 10 health
  await registerHealthGroup(ctx);
  // 20 workspace-read
  await registerWorkspaceReadGroup(ctx);
  // 20 workspace-write
  await registerWorkspaceWriteGroup(ctx);
}
