// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace media registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 80). Wires the V3-07 media read
// registrar that had no production caller before W4-WIRE
// (W4-FAILCLOSED report section 9 item 1).
//
// Routes declared by this group (kontrak 3.1, one wildcard
// registration answering two contract rows):
// - GET /api/workspace/media/* (routes/workspace-media-read.ts)
// - HEAD /api/workspace/media/* (routes/workspace-media-read.ts)
//
// Deps: the workspace root comes from config only. No index
// version resolver is wired: media versions stay null until the
// V3-06 index wiring supplies one (the read service treats an
// absent resolver as "no index available", which is the honest
// state for media until then). This adapter is deliberately
// separate from the record assets group (rank 130): media serves
// workspace files, assets serve record attachments (desain
// registrasi section 3.3).

import type { RegistrationContext } from '../registration/context.js';
import { registerWorkspaceMediaReadRoutes } from './workspace-media-read.js';

export const REGISTRATION_ID = 'workspace-media' as const;
export const REGISTRATION_ORDER = 80;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  await registerWorkspaceMediaReadRoutes(ctx.app, {
    workspaceRoot: ctx.config.workspaceRoot,
  });
}
