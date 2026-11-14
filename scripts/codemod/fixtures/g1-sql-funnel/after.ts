// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-sql-funnel. Synthetic example.

import { Database } from '@tauri-apps/plugin-sql';
import type { QueryResult } from '@tauri-apps/plugin-sql';

let cached: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!cached) {
    cached = await Database.load('sqlite:note.db');
  }
  return cached;
}

export async function runQuery(sql: string, params: unknown[]): Promise<QueryResult> {
  const db = await getDb();
  return db.execute(sql, params);
}

export async function runSelect<T>(sql: string, params: unknown[]): Promise<T[]> {
  const db = await getDb();
  return db.select<T>(sql, params);
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.close();
    cached = null;
  }
}
