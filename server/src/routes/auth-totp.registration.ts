// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// TOTP enrollment registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 24). Wires the V3-02 part 4 routes
// that had no production caller before merge 29b.
//
// Routes declared by this group (via registerAuthTotpRoutes,
// routes/auth-totp.ts; canonical contract section 3.12;
// desain-auth.md section 1.4):
// - POST /api/auth/totp/enroll/start
// - POST /api/auth/totp/enroll/confirm
// - POST /api/auth/totp/disable
// - POST /api/auth/totp/recovery-codes/regenerate
// Deps: the frozen AuthContext plus a DrizzleTotpEnrollmentStore
// built from the process-wide database handle (getDb, db/index.ts;
// the same singleton the settings store uses).
// Registration is skipped when the auth store is null or no
// database URL is configured, so a no-DATABASE_URL boot keeps
// booting (see server.ts) instead of throwing at startup.
// No RegistrationContext amendment is needed (AD-61).

import type { RegistrationContext } from '../registration/context.js';
import { getDb } from '../db/index.js';
import { registerAuthTotpRoutes } from './auth-totp.js';
import { DrizzleTotpEnrollmentStore } from '../services/auth/totp-enroll.js';

export const REGISTRATION_ID = 'auth-totp' as const;
export const REGISTRATION_ORDER = 24;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const databaseUrl = ctx.config.databaseUrl;
  if (
    ctx.auth !== undefined &&
    ctx.auth.store !== null &&
    databaseUrl !== undefined &&
    databaseUrl.trim() !== ''
  ) {
    const db = getDb(databaseUrl);
    await registerAuthTotpRoutes(ctx.app, {
      auth: ctx.auth,
      enrollment: new DrizzleTotpEnrollmentStore(db),
    });
  }
}
