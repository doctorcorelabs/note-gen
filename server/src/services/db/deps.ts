// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Default wiring for the db routes.
//
// createDefaultDbRouteDeps builds the dispatch dependencies from the
// server config: a Drizzle runner over DATABASE_URL (or the
// unavailable runner when no URL is configured), the default
// workspace resolver, the Drizzle idempotency store, and a fresh,
// empty handler registry.
//
// The registry starts empty on purpose: kind handlers belong to
// V3-13b, V3-13c, and V3-25 under the kind split in
// fase1/pembagian-handler-kind.md. Those merges register their
// handler maps into the registry instance this factory returns, in
// the db block of buildApp (see server/src/app.ts), before or after
// registerDbRoutes runs: dispatch looks handlers up per request, so
// registration order relative to route registration does not
// matter. Until a W1 handler lands, its kind answers 500; until a
// W2 handler lands, its kind answers 410. Neither case ever answers
// fake success.
//
// Wiring pattern (no barrel): each handler merge imports every one
// of its handler files DIRECTLY by path in the db block of
// buildApp and registers the exported `validate`/`handle` pair,
// one file per kind, for example (paths relative to server/src):
//
//   import { HANDLER_KIND as conversationsListKind, handle as conversationsList, validate as validateConversationsList } from './services/db/conversations-list.js';
//   dbDeps.registry.registerRead(conversationsListKind, { validate: validateConversationsList, handle: conversationsList });
//
// There is no services/db/index.ts barrel and there must never be
// one: the handler files are imported individually at the wiring
// point, and dispatch resolves kinds only through this registry.
//
// Tests and embedders that need stub handlers, a fake runner, or a
// stub workspace resolver construct DbRouteDeps directly instead of
// calling this factory.

import { createDb } from '../../db/index.js';
import { drizzleIdempotencyStore, type IdempotencyStore } from './idempotency.js';
import { createDbHandlerRegistry, type DbHandlerRegistry } from './registry.js';
import { createDrizzleDbRunner, createUnavailableDbRunner, type DbTransactionRunner } from './runner.js';
import { resolveDefaultWorkspaceId, type WorkspaceResolver } from './workspace.js';

export interface DbRouteDeps {
  registry: DbHandlerRegistry;
  runner: DbTransactionRunner;
  resolveWorkspaceId: WorkspaceResolver;
  idempotencyStore: IdempotencyStore;
}

export function createDefaultDbRouteDeps(config: { databaseUrl: string | undefined }): DbRouteDeps {
  return {
    registry: createDbHandlerRegistry(),
    runner:
      config.databaseUrl !== undefined
        ? createDrizzleDbRunner(createDb(config.databaseUrl))
        : createUnavailableDbRunner(),
    resolveWorkspaceId: resolveDefaultWorkspaceId,
    idempotencyStore: drizzleIdempotencyStore,
  };
}

export async function closeDbRouteDeps(deps: DbRouteDeps): Promise<void> {
  await deps.runner.close();
}
