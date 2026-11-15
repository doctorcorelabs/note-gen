// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture route file for check-registration-order.mjs (positive
// case). Declares one app.route call with a method array plus one
// plain GET route.

import type { FixtureApp } from './mini-app.js';

export interface WorkspaceReadRouteDeps {
  workspaceRoot: string;
}

export async function registerWorkspaceReadRoutes(
  app: FixtureApp,
  deps: WorkspaceReadRouteDeps,
): Promise<void> {
  const root = deps.workspaceRoot;
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/workspace/file',
    config: { requiresAuth: true },
    handler: async (request, reply) => {
      return reply.code(200).send(`${request.path}:${root}`);
    },
  });
  app.get('/api/workspace/list', async (request, reply) => {
    return reply.code(200).send(`${request.path}:${root}`);
  });
}
