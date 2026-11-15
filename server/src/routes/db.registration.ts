// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Db/transactions registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 100). Verbatim move of the
// db/transactions block of buildApp (app.ts, V3-13a; canonical
// contract section 3.4) plus the kind handler wiring, which comes
// from the generated handler module (desain section 8.1).
//
// Routes declared by this group (via registerDbRoutes, routes/db.ts):
// - POST /api/transactions
// - POST /api/db/batch
// The empty-batch FIX is preserved unchanged: POST /api/db/batch
// with an empty operations array answers 400 validation_failed.
// That behavior lives in services/db/validation.ts and routes/db.ts,
// both untouched here; this adapter only registers the route.
// Deps: dbDeps from createDefaultDbRouteDeps(ctx.config)
// (services/db/deps.ts). The registry starts empty on purpose;
// registerDbHandlers populates it from handlers.generated.ts
// before registerDbRoutes runs (dispatch looks handlers up per
// request, so the order relative to route registration does not
// matter). Handlers: 72 total on trunk 9c7b69d9 (34 read + 38
// write; 8 handlers intentionally without a validate step answer
// 410, so validation must never mask an unavailable capability).
// The 54 handlers of the trunk app.ts block are a subset, verified
// identical by kind, read/write side, and validate presence
// (AD-82); the other 18 are the G-3B6 records handlers, newly
// dispatchable through the db path by design, so this substitution
// does change behavior relative to the 54-handler block. No
// onClose hook is added here: this adapter only appends the db
// close step to the shared close registry (FIX-05, AD-81/B-12);
// the single hook lives in the auth-core adapter and reads the
// registry at close time.

import type { RegistrationContext } from '../registration/context.js';
import { registerDbCloseStep } from '../registration/db-close.js';
import { registerDbRoutes } from './db.js';
import { createDefaultDbRouteDeps } from '../services/db/deps.js';
import { registerDbHandlers } from '../services/db/handlers.generated.js';

export const REGISTRATION_ID = 'db' as const;
export const REGISTRATION_ORDER = 100;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const dbDeps = createDefaultDbRouteDeps(ctx.config);
  registerDbCloseStep(ctx.close, dbDeps);
  registerDbHandlers(dbDeps.registry);
  await registerDbRoutes(ctx.app, dbDeps);
}
