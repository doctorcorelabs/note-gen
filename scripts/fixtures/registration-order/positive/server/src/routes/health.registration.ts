// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture adapter for check-registration-order.mjs (positive case):
// well-formed contract, rank 10, health first.

import type { RegistrationContext } from '../registration/context.js';
import { registerHealthRoutes } from './health.js';

export const REGISTRATION_ID = 'health' as const;
export const REGISTRATION_ORDER = 10;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  await registerHealthRoutes(ctx.app, { version: ctx.version });
}
