// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Auth core route group adapter (kontrak 3.12; V3-01; AD-61).
// Rank 20: auth registers second, after health. This moves the auth
// core block of buildApp verbatim into adapter form. The onClose
// lifecycle wiring (FIX-05, AD-81/B-12) lives here too: when an
// auth context is present, this adapter appends the auth close
// step to the shared close registry and registers the single
// onClose hook, which reads the registry at close time so the db
// step appended later by the db adapter still runs, after auth.
// When no auth context is injected, no auth route exists, no hook
// is registered, and the deny-by-default behavior is unchanged.

import type { RegistrationContext } from '../registration/context.js';
import { registerAuthCloseStep } from '../registration/auth-close.js';
import { registerCloseHook } from '../registration/close-hook.js';
import { registerAuthCoreRoutes } from './auth-core.js';

export const REGISTRATION_ID = 'auth-core' as const;
export const REGISTRATION_ORDER = 20;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  if (ctx.auth !== undefined) {
    const auth = ctx.auth;
    await registerAuthCoreRoutes(ctx.app, { auth });
    registerAuthCloseStep(ctx.close, auth);
    registerCloseHook(ctx.app, ctx.close);
  }
}
