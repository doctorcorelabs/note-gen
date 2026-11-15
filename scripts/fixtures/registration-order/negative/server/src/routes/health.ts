// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture route file for check-registration-order.mjs (negative
// case). Same healthy shape as the positive fixture; the violations
// in this tree come from the rank clash and the duplicate route,
// not from this file.

import type { FixtureApp, FixtureHandler, FixtureRouteOptions } from './mini-app.js';

export const HEALTH_LIVE_PATH = '/api/health/live';
export const HEALTH_READY_PATH = '/api/health/ready';

export interface HealthRouteDeps {
  version: string;
}

export async function registerHealthRoutes(app: FixtureApp, deps: HealthRouteDeps): Promise<void> {
  const version = deps.version;
  const readyHandler: FixtureHandler = async (request, reply) => {
    return reply.code(200).send(`${request.path}:${version}`);
  };
  const readyOptions: FixtureRouteOptions = { config: { requiresAuth: false } };
  app.get(
    HEALTH_LIVE_PATH,
    readyOptions,
    async (request, reply) => {
      return reply.code(200).send(`${request.path}:${version}`);
    },
  );
  app.get(HEALTH_READY_PATH, readyOptions, readyHandler);
}
