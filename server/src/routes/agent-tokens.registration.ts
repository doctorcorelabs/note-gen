// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Agent token management registration adapter (F2-1 wave
// G-F2-1d, rank 25). Registers the cookie-authenticated token
// management routes only when an auth context is injected,
// mirroring the auth-core adapter: without the injection no
// management route exists and deny-by-default is unchanged.

import type { RegistrationContext } from '../registration/context.js';
import { registerAgentTokenRoutes } from './agent-tokens.js';

export const REGISTRATION_ID = 'agent-tokens' as const;
export const REGISTRATION_ORDER = 25;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  if (ctx.auth !== undefined) {
    await registerAgentTokenRoutes(ctx.app, { auth: ctx.auth });
  }
}
