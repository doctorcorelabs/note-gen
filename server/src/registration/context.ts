// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// RegistrationContext: exactly what the route blocks in buildApp use,
// no more. Frozen, amendment-only (desain-registrasi-programatik.md
// seksi 3.2): adding a field follows the same rule as adding an
// AppDeps field. Derivation from an existing field inside an adapter
// is preferred over a new field.

import type { FastifyInstance } from 'fastify';
import type { AuthContext } from '../auth/context.js';
import type { ServerConfig } from '../config.js';
import type { HealthDbPool } from '../db/pool.js';

export interface RegistrationContext {
  app: FastifyInstance;
  config: ServerConfig;
  pool: HealthDbPool | null;
  version: string;
  auth?: AuthContext;
}
