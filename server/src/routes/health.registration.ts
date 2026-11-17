// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Health route group adapter (kontrak 3.14; AD-61). Rank 10: health
// registers first. This moves the health block of buildApp verbatim
// into adapter form: same registrar, same deps mapping, no behavior
// change. RegistrationContext supplies the values buildApp used to
// pass from AppDeps.

import type { RegistrationContext } from '../registration/context.js';
import { registerHealthRoutes } from './health.js';

export const REGISTRATION_ID = 'health' as const;
export const REGISTRATION_ORDER = 10;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  // F-MIGCHECK wiring: the ready endpoint runs the real migrations
  // check over the same application pool the db check uses, with the
  // default disk manifest. Readiness now proves the schema current
  // (migrations_current) or fails on drift, instead of reporting
  // check_not_configured while drift was provable only through the
  // standalone runner. No new RegistrationContext field is needed:
  // pool and checkTimeoutMs already travel in the context.
  await registerHealthRoutes(ctx.app, {
    pool: ctx.pool,
    workspaceRoot: ctx.config.workspaceRoot,
    version: ctx.version,
    checkTimeoutMs: ctx.config.checkTimeoutMs,
    overallTimeoutMs: ctx.config.overallTimeoutMs,
    migrationCheck: { pool: ctx.pool, timeoutMs: ctx.config.checkTimeoutMs },
  });
}
