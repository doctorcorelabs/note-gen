// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Per-kind handler registry for the db routes.
//
// One kind maps to exactly one handler (AD-42f, O-10). This module
// defines the handler contract and the registry; it contains NO kind
// handlers. Handlers are written by V3-13b, V3-13c, and V3-25 under
// the kind split recorded in fase1/pembagian-handler-kind.md, and each
// handler module registers its kinds into the registry instance the
// app wiring passes to the routes. Registering a second handler for
// the same kind throws: a duplicate is a wiring bug, never a silent
// override.
//
// Handler contract:
// - A handler receives the Drizzle transaction for the request, the
//   workspace id resolved from the authenticated session, the user
//   id, the request id, and the operation object as validated data.
//   It never receives SQL, a table name, a column name, or a
//   workspace id from the client (AD-26).
// - A handler validates its own per-kind fields. Dispatch guarantees
//   the kind is known, belongs to the endpoint group, and carries no
//   forbidden field, and it runs a handler's optional `validate`
//   step for every operation BEFORE the transaction opens, so a
//   validation failure never executes a partial transaction. A
//   handler without `validate` validates inside `handle`; any
//   failure there still rolls the whole transaction back.
// - A handler signals domain failures by throwing ApiError with a
//   catalog code (revision_conflict, record_tags_changed, tag_in_use,
//   not_found, and so on). Dispatch adds operationIndex and kind to
//   the error details and lets the global error handler render the
//   envelope. A handler must never throw with SQL text, a secret, or
//   an absolute path in the message or details.
// - A read handler returns the rows array for its kind. A write
//   handler returns { affected, id?, version? } and, only for
//   wiki.commitRevision, { committed } as well. Dispatch validates
//   the shape and renders the contract result entry. A handler
//   that deletes asset-bearing rows may also return the
//   internal-only { assetKeys } field; dispatch sweeps those keys
//   after commit and never renders them (F02-04b).
// - A handler must not run DDL, touch the filesystem, or call an AI
//   provider inside the transaction (V1-03 section 4.3 rule 8).

import type { Database } from '../../db/index.js';
import type { DbReadOpKind, DbWriteOpKind } from './kinds.js';

// The Drizzle transaction object type, derived from the Database
// handle so handler authors get the exact transaction type without
// importing drizzle internals.
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbOperationInput {
  kind: string;
  [key: string]: unknown;
}

export interface DbHandlerContext {
  tx: DbTransaction;
  workspaceId: string;
  userId: string;
  requestId: string;
  // The transaction id of the enclosing POST /api/transactions
  // request, or null for a read batch, which has no transaction id.
  transactionId: string | null;
}

export interface DbWriteResultInput {
  affected: number;
  id?: number | string;
  version?: number;
  // Only meaningful for wiki.commitRevision: a guard miss returns
  // committed false with HTTP 200 instead of throwing (V1-03 4.5).
  committed?: boolean;
  // Internal-only (F02-04b): asset keys of rows deleted by this
  // operation, swept by dispatch after commit. Never rendered to
  // the wire; normalizeWriteResult drops the field.
  assetKeys?: readonly string[];
}

export type DbReadHandler = (ctx: DbHandlerContext, op: DbOperationInput) => Promise<readonly unknown[]>;

export type DbWriteHandler = (ctx: DbHandlerContext, op: DbOperationInput) => Promise<DbWriteResultInput>;

export interface DbReadHandlerDefinition {
  validate?: (op: DbOperationInput) => void;
  handle: DbReadHandler;
}

export interface DbWriteHandlerDefinition {
  validate?: (op: DbOperationInput) => void;
  handle: DbWriteHandler;
}

export type DbReadHandlerRegistration = DbReadHandler | DbReadHandlerDefinition;
export type DbWriteHandlerRegistration = DbWriteHandler | DbWriteHandlerDefinition;

function normalizeRead(registration: DbReadHandlerRegistration): DbReadHandlerDefinition {
  return typeof registration === 'function' ? { handle: registration } : registration;
}

function normalizeWrite(registration: DbWriteHandlerRegistration): DbWriteHandlerDefinition {
  return typeof registration === 'function' ? { handle: registration } : registration;
}

export class DbHandlerRegistry {
  private readonly reads = new Map<DbReadOpKind, DbReadHandlerDefinition>();
  private readonly writes = new Map<DbWriteOpKind, DbWriteHandlerDefinition>();

  registerRead(kind: DbReadOpKind, handler: DbReadHandlerRegistration): void {
    if (this.reads.has(kind)) {
      throw new Error(`Duplicate read handler for kind: ${kind}`);
    }
    this.reads.set(kind, normalizeRead(handler));
  }

  registerWrite(kind: DbWriteOpKind, handler: DbWriteHandlerRegistration): void {
    if (this.writes.has(kind)) {
      throw new Error(`Duplicate write handler for kind: ${kind}`);
    }
    this.writes.set(kind, normalizeWrite(handler));
  }

  registerReadMap(map: Partial<Record<DbReadOpKind, DbReadHandlerRegistration>>): void {
    for (const [kind, handler] of Object.entries(map)) {
      if (handler !== undefined) {
        this.registerRead(kind as DbReadOpKind, handler);
      }
    }
  }

  registerWriteMap(map: Partial<Record<DbWriteOpKind, DbWriteHandlerRegistration>>): void {
    for (const [kind, handler] of Object.entries(map)) {
      if (handler !== undefined) {
        this.registerWrite(kind as DbWriteOpKind, handler);
      }
    }
  }

  getRead(kind: string): DbReadHandlerDefinition | undefined {
    return this.reads.get(kind as DbReadOpKind);
  }

  getWrite(kind: string): DbWriteHandlerDefinition | undefined {
    return this.writes.get(kind as DbWriteOpKind);
  }

  hasRead(kind: string): boolean {
    return this.reads.has(kind as DbReadOpKind);
  }

  hasWrite(kind: string): boolean {
    return this.writes.has(kind as DbWriteOpKind);
  }

  readKinds(): DbReadOpKind[] {
    return [...this.reads.keys()];
  }

  writeKinds(): DbWriteOpKind[] {
    return [...this.writes.keys()];
  }
}

export function createDbHandlerRegistry(): DbHandlerRegistry {
  return new DbHandlerRegistry();
}
