// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Minimal handler registration seam (kind-free skeleton).
//
// The route dispatch worker (V3-13a, branch web-db-routes) owns the
// dispatch entry point. That branch did not exist when this skeleton
// was written, so this file defines the smallest registration seam the
// per-kind handlers will plug into: an immutable registry mapping an
// operation kind string to its handler, plus a dispatch helper that
// rejects unknown kinds. The integrator reconciles this seam with the
// V3-13a dispatch design when both branches merge; handler files must
// import only this seam and handler.ts, never the routes.
//
// This registry starts empty on purpose. Entries appear only through
// per-kind handler files written after the AD-42f division note
// exists. No handler is registered here and no kind is named here.

import type { DbHandler, DbHandlerContext } from "./handler.js";

/** Handler stored in the registry, with its input and result erased. */
export type RegisteredDbHandler = DbHandler<unknown, unknown>;

/** Immutable kind-to-handler registry. */
export type DbHandlerRegistry = ReadonlyMap<string, RegisteredDbHandler>;

/** The empty registry. Per-kind handler files extend it via merge. */
export const EMPTY_DB_HANDLER_REGISTRY: DbHandlerRegistry = new Map();

/**
 * Merge registry fragments into one registry. Duplicate kinds are a
 * programmer error: merging two fragments that register the same kind
 * throws, so one kind can never have two handlers.
 */
export function mergeDbHandlerRegistries(
  ...fragments: readonly DbHandlerRegistry[]
): DbHandlerRegistry {
  const merged = new Map<string, RegisteredDbHandler>();
  for (const fragment of fragments) {
    for (const [kind, handler] of fragment) {
      if (merged.has(kind)) {
        throw new Error(`Duplicate database handler for kind: ${kind}`);
      }
      merged.set(kind, handler);
    }
  }
  return merged;
}

/**
 * Dispatch one operation to its registered handler. Unknown kinds are
 * rejected with an error that names the kind; no fallback and no raw
 * execution path exists.
 */
export async function dispatchDbHandler(
  registry: DbHandlerRegistry,
  ctx: DbHandlerContext,
  kind: string,
  input: unknown,
): Promise<unknown> {
  const handler = registry.get(kind);
  if (handler === undefined) {
    throw new Error(`Unknown database operation kind: ${kind}`);
  }
  return handler(ctx, input);
}
