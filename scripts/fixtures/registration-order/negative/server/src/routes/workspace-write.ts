// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture route file for check-registration-order.mjs (negative
// case). Declares POST /api/shared through the SHARED_PATH
// constant, duplicating the literal declaration in the read
// fixture. The checker must resolve the constant and report C-5.

import type { FixtureApp } from './mini-app.js';

export const SHARED_PATH = '/api/shared';

export interface WorkspaceWriteRouteDeps {
  workspaceRoot: string;
}

export async function registerWorkspaceWriteRoutes(
  app: FixtureApp,
  deps: WorkspaceWriteRouteDeps,
): Promise<void> {
  const root = deps.workspaceRoot;
  app.post(SHARED_PATH, async (request, reply) => {
    return reply.code(200).send(`${request.path}:${root}`);
  });
  app.put('/api/workspace/file', async (request, reply) => {
    return reply.code(200).send(`${request.path}:${root}`);
  });
}
