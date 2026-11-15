// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Explicit 501 stubs registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 140). Verbatim move of the stubs
// block of buildApp (app.ts, V3-39a; canonical contract section 7).
//
// Routes declared by this group (via registerStubRoutes, routes/stubs.ts):
// - POST /api/backups/restore (501 restore_unavailable)
// - POST /api/documents/parse (501 document_parse_unavailable)
// The third contract section 7 stub, POST /api/search/fuzzy, belongs
// to the search group (V3-27), not to this registrar.
// Deps: { maxBodyBytes } from ctx.config.maxBodyBytes, as in app.ts.
// The stubs answer 501 only after the auth hook passes, with no side
// effects. Parser note: the stubs reuse the workspace-write multipart
// parser when present (rank 50, before this group) and enforce the
// body limit in the handlers, so wire behavior does not depend on
// which parser produced the body. See routes/stubs.ts.

import type { RegistrationContext } from '../registration/context.js';
import { registerStubRoutes } from './stubs.js';

export const REGISTRATION_ID = 'stubs' as const;
export const REGISTRATION_ORDER = 140;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  await registerStubRoutes(ctx.app, { maxBodyBytes: ctx.config.maxBodyBytes });
}
