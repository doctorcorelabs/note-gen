// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Search registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 120). Wires the V3-27 search
// registrar that had no production caller before W4-WIRE
// (HARNESS-5), including the 501 fuzzy stub, which belongs to
// this group and not to the stubs adapter (S5-Q4).
//
// Routes declared by this group (kontrak 3.9):
// - GET /api/search (routes/search.ts)
// - POST /api/search/fuzzy (routes/search.ts, 501 stub)
//
// Deps: the direct keyword search port
// (services/search/direct.ts) over a dedicated Drizzle handle
// when DATABASE_URL is configured, the workspace root from
// config, and the Drizzle identity resolver. Without a database
// URL, the port is still wired and fails closed per request
// (503 for record scope, files scope still served from disk
// with unknown versions). The handle's close step is appended
// to the shared close registry.

import type { RegistrationContext } from '../registration/context.js';
import { createDb } from '../db/index.js';
import { ApiError } from '../plugins/envelope.js';
import { registerSearchRoutes } from './search.js';
import { createDirectKeywordSearchPort } from '../services/search/direct.js';
import { createDrizzleWorkspaceIdentityResolver } from '../services/workspace/reconcile-index-pg.js';

export const REGISTRATION_ID = 'search' as const;
export const REGISTRATION_ORDER = 120;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const databaseUrl = ctx.config.databaseUrl;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    const handle = createDb(databaseUrl);
    ctx.close.append(async () => {
      await handle.close();
    });
    const resolveIdentity = createDrizzleWorkspaceIdentityResolver(handle.db);
    const search = createDirectKeywordSearchPort({
      db: handle.db,
      workspaceRoot: ctx.config.workspaceRoot,
      resolveWorkspaceId: async (principal) => {
        const identity = await resolveIdentity(principal);
        return identity?.workspaceId ?? null;
      },
    });
    await registerSearchRoutes(ctx.app, { search });
  } else {
    const search = createDirectKeywordSearchPort({
      workspaceRoot: ctx.config.workspaceRoot,
      resolveWorkspaceId: async () => {
        throw ApiError.serviceUnavailable('The database is not available.');
      },
    });
    await registerSearchRoutes(ctx.app, { search });
  }
}
