// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Db close adapter: appends the db-runner close step to the shared
// close registry.
//
// In the registration form the db adapter (rank 100) calls this
// with the db deps instance it built, after the auth-core adapter
// (rank 20) appended the auth step, so the single onClose hook runs
// auth first and the db runner second, preserving the FIX-05 order.
// This adapter never registers a hook of its own: the hook lives in
// the auth adapter via registerCloseHook, and the hook body reads
// the registry at close time.

import { closeDbRouteDeps, type DbRouteDeps } from '../services/db/deps.js';
import type { CloseRegistry } from './close-registry.js';

export function registerDbCloseStep(registry: CloseRegistry, dbDeps: DbRouteDeps): void {
  registry.append(async () => {
    await closeDbRouteDeps(dbDeps);
  });
}
