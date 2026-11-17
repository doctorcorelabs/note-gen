// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace events registration adapter (AD-61; desain
// registrasi programatik section 3.3, rank 160, LAST). Wires
// the WebSocket events route (W4-WIRE, S5-F7/HARNESS-5): the
// single non-HTTP contract route, GET /api/workspace/events
// upgraded to a WebSocket.
//
// The handshake verifier is built from the injected auth
// context with the same factory buildApp uses for the HTTP
// auth hook, and the canonical origin comes from that context
// (PUBLIC_BASE_URL). When no auth context is injected, the
// route still attaches but every handshake fails closed: the
// origin check has no canonical origin to match, so upgrades
// answer 403 before any session work. Socket cleanup runs
// from a preClose hook inside the route module (the only
// order that cannot deadlock server.close()); the close step
// appended here is the same idempotent shutdown, kept so the
// registry owns the full lifecycle like every other adapter.

import type { RegistrationContext } from '../registration/context.js';
import { createSessionVerifier } from '../middleware/session.js';
import type { VerifySessionFn } from '../middleware/auth-hook.js';
import { registerWorkspaceEventsRoutes } from './workspace-events.js';

export const REGISTRATION_ID = 'events' as const;
export const REGISTRATION_ORDER = 160;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const auth = ctx.auth;
  const verifySession: VerifySessionFn =
    auth === undefined ? async () => null : createSessionVerifier(auth);
  const handle = await registerWorkspaceEventsRoutes(ctx.app, {
    verifySession,
    canonicalOrigin: auth?.canonicalOrigin,
  });
  ctx.close.append(async () => {
    await handle.close();
  });
}
