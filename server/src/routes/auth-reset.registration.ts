// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Password reset registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 22). Wires the V3-02 part 3 routes
// that had no production caller before merge 29b.
//
// Routes declared by this group (via registerAuthResetRoutes,
// routes/auth-reset.ts; canonical contract section 3.12):
// - POST /api/auth/password/reset-request
// - POST /api/auth/password/reset-confirm
// Deps: the frozen AuthContext plus a DrizzlePasswordResetStore
// built from the process-wide database handle (getDb, db/index.ts;
// the same singleton the settings store uses). smtpConfigured is
// false: no mailer exists in the MVP, and the service answers
// generically without sending mail (see routes/auth-reset.ts).
// Registration is skipped when the auth store is null or no
// database URL is configured, so a no-DATABASE_URL boot keeps
// booting (see server.ts) instead of throwing at startup.
// No RegistrationContext amendment is needed (AD-61).

import type { RegistrationContext } from '../registration/context.js';
import { getDb } from '../db/index.js';
import { registerAuthResetRoutes } from './auth-reset.js';
import { DrizzlePasswordResetStore } from '../services/auth/password-reset.js';

export const REGISTRATION_ID = 'auth-reset' as const;
export const REGISTRATION_ORDER = 22;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const databaseUrl = ctx.config.databaseUrl;
  if (
    ctx.auth !== undefined &&
    ctx.auth.store !== null &&
    databaseUrl !== undefined &&
    databaseUrl.trim() !== ''
  ) {
    const db = getDb(databaseUrl);
    await registerAuthResetRoutes(ctx.app, {
      auth: ctx.auth,
      resetStore: new DrizzlePasswordResetStore(db),
      smtpConfigured: false,
    });
  }
}
