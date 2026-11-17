// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Password change registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 21). Wires the V3-02 part 2 route
// that had no production caller before merge 29b.
//
// Routes declared by this group (via registerAuthPasswordRoutes,
// routes/auth-password.ts; canonical contract section 3.12):
// - POST /api/auth/password/change
// Deps: the frozen AuthContext only. Registration mirrors the
// auth-core adapter: when ctx.auth is present the route is
// registered and handlers fail closed with 503 through
// requireStore when the store is null (no DATABASE_URL boot).
// No RegistrationContext amendment is needed (AD-61).

import type { RegistrationContext } from '../registration/context.js';
import { registerAuthPasswordRoutes } from './auth-password.js';

export const REGISTRATION_ID = 'auth-password' as const;
export const REGISTRATION_ORDER = 21;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  if (ctx.auth !== undefined) {
    await registerAuthPasswordRoutes(ctx.app, { auth: ctx.auth });
  }
}
