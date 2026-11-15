// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Settings and secrets registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 90). Verbatim move of the settings
// and secrets block of buildApp (app.ts, V3-10a; canonical contract
// sections 3.2-3.3). The pair MUST NOT be split into two adapters:
// both registrars share one deps instance from a single factory call,
// exactly as in app.ts.
//
// Routes declared by this group:
// - via registerSettingsRoutes (routes/settings.ts):
//   GET /api/settings, PATCH /api/settings, GET /api/settings/revision
// - via registerSecretsRoutes (routes/secrets.ts):
//   GET /api/settings/secrets/status,
//   PUT /api/settings/secrets/ai-providers,
//   DELETE /api/settings/secrets/ai-providers/:providerKey
// Deps: one shared settingsDeps from createProductionSettingsDeps()
// (services/settings/index.ts, no arguments; the factory reads env
// internally). The secret cipher is wired by V3-10b: with
// ENCRYPTION_KEY set the real adapter seals secrets; without it,
// secret writes fail closed with 503 (see
// services/settings/crypto-seam.ts). This adapter only adds routes;
// it does not change the frozen middleware shape (AD-40) or AppDeps.

import type { RegistrationContext } from '../registration/context.js';
import { registerSecretsRoutes } from './secrets.js';
import { registerSettingsRoutes } from './settings.js';
import { createProductionSettingsDeps } from '../services/settings/index.js';

export const REGISTRATION_ID = 'settings-secrets' as const;
export const REGISTRATION_ORDER = 90;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  const settingsDeps = createProductionSettingsDeps();
  await registerSettingsRoutes(ctx.app, settingsDeps);
  await registerSecretsRoutes(ctx.app, settingsDeps);
}
