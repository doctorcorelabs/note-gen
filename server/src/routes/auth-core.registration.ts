// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Auth core route group adapter (kontrak 3.12; V3-01; AD-61).
// Rank 20: auth registers second, after health. This moves the auth
// core block of buildApp verbatim into adapter form, except the
// onClose lifecycle hook, which is intentionally NOT moved here: the
// hook in app.ts also closes the db route deps, so lifecycle wiring
// owns it. When no auth context is injected, no auth route exists
// and the deny-by-default behavior is unchanged.

import type { RegistrationContext } from '../registration/context.js';
import { registerAuthCoreRoutes } from './auth-core.js';

export const REGISTRATION_ID = 'auth-core' as const;
export const REGISTRATION_ORDER = 20;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  if (ctx.auth !== undefined) {
    const auth = ctx.auth;
    await registerAuthCoreRoutes(ctx.app, { auth });
  }
}
