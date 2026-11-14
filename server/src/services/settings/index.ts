// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Barrel for the settings and secrets services (V3-10a). Route
// modules import from the individual files; app.ts uses
// createProductionSettingsDeps for the default wiring.

export * from './classification.js';
export * from './crypto-seam.js';
export * from './drizzle-store.js';
export * from './settings-service.js';
export * from './store.js';
export * from './validation.js';

import { unavailableSecretCipher } from './crypto-seam.js';
import { createProductionSettingsStore } from './drizzle-store.js';
import type { SettingsServiceDeps } from './settings-service.js';

// Default production wiring for the settings/secrets routes. The
// store resolves the Drizzle handle lazily (503 when no database is
// configured). The cipher is the fail-closed placeholder until the
// V3-10b envelope implementation is wired: the integrator (or the
// V3-01 merge, which owns AppDeps injection) replaces
// unavailableSecretCipher with the real SecretCipher when registering
// the routes with explicit deps. This factory adds no AppDeps field
// (AD-40: AppDeps changes need a recorded amendment).
export function createProductionSettingsDeps(): SettingsServiceDeps {
  return {
    cipher: unavailableSecretCipher,
    store: createProductionSettingsStore(),
  };
}
