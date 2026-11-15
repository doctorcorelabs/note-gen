// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture app.ts for check-registration-order.mjs (positive case):
// migrated shape, delegates to the generated index only.

import type { FixtureApp } from './routes/mini-app.js';
import type { RegistrationContext } from './registration/context.js';
import { registerRouteGroups } from './routes-generated.js';

export async function buildFixtureApp(app: FixtureApp): Promise<void> {
  const ctx: RegistrationContext = { app, version: 'fixture', workspaceRoot: '/tmp/fixture' };
  await registerRouteGroups(ctx);
}
