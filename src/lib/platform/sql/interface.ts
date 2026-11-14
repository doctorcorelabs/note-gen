// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * SqlAdapter interface (migration wave G1, data blocker).
 *
 * Replaces the upstream plugin-sql surface: the Database class reached
 * through load, plus execute, select, and close. Upstream exports
 * Database as a default import and QueryResult as a named type; only
 * src/db/index.ts imports this module, and it funnels all callers through
 * getDb, so the adapter keeps the same narrow shape. Signatures mirror
 * the installed upstream declarations (plugin-sql 2.x).
 *
 * The static get and the path property have no call sites and are
 * excluded. SQL dialect handling is a backend concern, not a shim
 * concern; the adapter only fixes the { sql, params } contract and the
 * QueryResult shape.
 */
export interface QueryResult {
  rowsAffected: number;
  lastInsertId?: number;
}

export interface SqlDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<QueryResult>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  close(db?: string): Promise<boolean>;
}

export interface SqlAdapter {
  load(path: string): Promise<SqlDatabase>;
}
