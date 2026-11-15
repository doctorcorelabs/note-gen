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

import { createSecretCipherFromEnv } from '../../lib/crypto/index.js';
import { unavailableSecretCipher, type SecretCipher } from './crypto-seam.js';
import { createProductionSettingsStore } from './drizzle-store.js';
import type { SettingsServiceDeps } from './settings-service.js';

// Default production wiring for the settings/secrets routes. The
// store resolves the Drizzle handle lazily (503 when no database is
// configured). The cipher is the real V3-10b adapter built from the
// environment (ENCRYPTION_KEY, canonical); when the key is missing
// or invalid the factory throws and this wiring keeps the
// fail-closed placeholder (secret writes 503, status reads still
// work) instead of starting a server that pretends to seal secrets.
// The config layer already warns at boot when ENCRYPTION_KEY is
// unset (config/env.ts). Wired by the V3-10b integrator (W7/W8,
// AD-53); see the adapter note in crypto-seam.ts. This factory adds
// no AppDeps field (AD-40: AppDeps changes need a recorded
// amendment).
export function createProductionSettingsDeps(): SettingsServiceDeps {
  let cipher: SecretCipher;
  try {
    cipher = createSecretCipherFromEnv(process.env);
  } catch {
    cipher = unavailableSecretCipher;
  }
  return {
    cipher,
    store: createProductionSettingsStore(),
  };
}
