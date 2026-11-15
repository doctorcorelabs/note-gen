// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Auth close adapter: appends the auth-context close step to the
// shared close registry.
//
// This step must be appended before the db close step. In the
// registration form the auth-core adapter (rank 20) runs before the
// db adapter (rank 100), so append order is auth first, then db,
// preserving the FIX-05 order. Closing the auth context is
// idempotent (auth/context.ts), and server.ts also closes it.

import type { AuthContext } from '../auth/context.js';
import type { CloseRegistry } from './close-registry.js';

export function registerAuthCloseStep(registry: CloseRegistry, auth: AuthContext): void {
  registry.append(async () => {
    await auth.close();
  });
}
