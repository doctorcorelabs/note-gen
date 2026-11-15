// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Registration adapter for the workspace-write group (AD-61, hybrid
// registration). This file only moves the app.ts route block for
// this group into the adapter form; it changes no handler behavior.
//
// Routes declared by the registrar (kontrak 3.1, write side only):
//   PUT  /api/workspace/file
//   POST /api/workspace/file/append
//   POST /api/workspace/file/patch
//   POST /api/workspace/media
//   PUT  /api/workspace/media
//
// Deps: the V3-04a path/revision modules are wired through the
// write-adapter ports (same workspace key default as the read
// side); the index, event, and idempotency ports stay unwired
// until their workers land, so writes succeed with null versions
// and no key replay, exactly as the port contract documents. No
// resolveIdentity yet: the session-to-workspace mapping is future
// work.
//
// G8-D1 / FIX-06 (AD-71) - how the no-Content-Type cap is carried:
// the cap lives inside the registrar, not in app.ts and not in
// this adapter. registerWorkspaceWriteRoutes calls
// registerBufferParsers with the default limits (2 MiB text,
// 20 MiB media) because this adapter passes no textLimitBytes or
// mediaLimitBytes override, exactly as the app.ts block does
// today. The catch-all '*' parser then turns a missing
// Content-Type on a write route into a Buffer body capped by
// writeRouteCap (text cap for PUT file and POST append/patch,
// media cap for PUT/POST media), while a present-but-unknown
// Content-Type still answers 415 and a missing Content-Type
// outside the write routes still answers 415. This adapter must
// never add limit overrides or its own parser: calling the
// registrar unchanged, with the same deps shape, is what keeps
// the FIX-06 behavior. Rank 50 also preserves parser
// registration order before stubs (140); see desain seksi 4.3.

import type { RegistrationContext } from '../registration/context.js';
import { registerWorkspaceWriteRoutes } from './workspace-write.js';
import { createV304aWritePorts } from '../services/workspace/write-adapter.js';

export const REGISTRATION_ID = 'workspace-write' as const;
export const REGISTRATION_ORDER = 50;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  await registerWorkspaceWriteRoutes(ctx.app, {
    ports: createV304aWritePorts(ctx.config.workspaceRoot),
  });
}
