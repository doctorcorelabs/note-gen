// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Generic database handler framework (kind-free skeleton).
//
// This file defines only the shared shape every per-kind handler must
// follow: a typed input in, a typed result out, Drizzle only, no raw
// SQL strings (AD-26). It defines no per-kind handler and names no
// operation kind. Per-kind handlers land only after the handler-kind
// division note exists (AD-42f gate, see README.md in this directory);
// each handler then lives in its own file in this directory and is
// registered through the seam described in registry.ts.
//
// The workspace id is never an operation field. It arrives in the
// handler context from the authenticated session and route, matching
// the catalog rule that workspace_id is never part of an operation
// payload.

import type { Database } from "../../db/index.js";

/** Execution context shared by every database handler. */
export interface DbHandlerContext {
  /** Drizzle database handle. Handlers use Drizzle only. */
  readonly db: Database;
  /** Workspace taken from the authenticated session and route. */
  readonly workspaceId: string;
}

/**
 * A database handler: a typed operation input in, a typed result out.
 *
 * Handlers must scope every query to `ctx.workspaceId`, must not run
 * raw SQL strings, and must not open their own transaction statements;
 * transaction grouping belongs to the caller dispatch path.
 */
export type DbHandler<TInput, TResult> = (
  ctx: DbHandlerContext,
  input: TInput,
) => Promise<TResult>;
