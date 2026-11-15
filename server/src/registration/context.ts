// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Registration context for route group adapters (AD-61; desain
// registrasi programatik section 3.2). Frozen: exactly the fields
// the current buildApp route block uses, plus the AD-81 amendment
// below. Adding a field follows the same rule as adding an AppDeps
// field (amendment only, recorded in DECISIONS.md).

import type { FastifyInstance } from 'fastify';
import type { AuthContext } from '../auth/context.js';
import type { ServerConfig } from '../config.js';
import type { HealthDbPool } from '../db/pool.js';
import type { CloseRegistry } from './close-registry.js';

export interface RegistrationContext {
  app: FastifyInstance;
  config: ServerConfig;
  pool: HealthDbPool | null;
  version: string;
  auth?: AuthContext;
  // AD-81 amendment: shared close registry (B-12). The auth-core
  // adapter appends the auth close step and registers the single
  // onClose hook; the db adapter appends the db close step.
  close: CloseRegistry;
}
