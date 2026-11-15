// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Transaction runner for the db routes: one pooled connection per
// request, all operations in a single Drizzle transaction, one
// failure rolling back everything (V1-03 section 4.3 rule 4, CT-X1).
// No caller issues manual transaction statements.
//
// The runner interface exists so route tests can substitute a fake
// that records commit/rollback without a database, while production
// uses the Drizzle runner over postgres.js (AD-05). Read batches run
// in a read-only transaction: a read handler that attempted a write
// would fail at the database and roll back, which keeps the batch
// endpoint read-pure by construction, not just by kind checking.

import { ApiError } from '../../plugins/envelope.js';
import type { DbHandle } from '../../db/index.js';
import type { DbTransaction } from './registry.js';

export interface DbTransactionRunner {
  runWrite<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>;
  runRead<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDrizzleDbRunner(handle: DbHandle): DbTransactionRunner {
  return {
    runWrite: async <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> => handle.db.transaction(fn),
    runRead: async <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
      handle.db.transaction(fn, { accessMode: 'read only' }),
    close: async (): Promise<void> => {
      await handle.close();
    },
  };
}

// Runner used when no DATABASE_URL is configured: every db request
// fails with service_unavailable (retryable) instead of crashing or
// answering with fake data. Readiness already reports the database
// as unconfigured in this state.
export function createUnavailableDbRunner(): DbTransactionRunner {
  const unavailable = async <T>(): Promise<T> => {
    throw ApiError.serviceUnavailable();
  };
  return {
    runWrite: unavailable,
    runRead: unavailable,
    close: async (): Promise<void> => {},
  };
}
