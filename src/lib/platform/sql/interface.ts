// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * SqlAdapter interface: EXPLICIT STUB (AD-26, applied at merge M5).
 *
 * The raw-SQL form from branch web-registry-g0 (SqlDatabase with
 * execute/select taking a SQL string, plus QueryResult) was REJECTED
 * and must never merge as-is: it encodes the superseded BFF design
 * ("SQL + bound parameters"), which AD-05 and the command triage
 * replaced with typed operations. No raw SQL from the client, no
 * table names, no SQL strings in the adapter contract.
 *
 * The canonical SqlAdapter shape is typed operations from the V2-24
 * operations catalog (74 kinds, DbReadOperation/DbWriteOperation),
 * owned by wave-3 worker V3-14. This stub intentionally exposes no
 * callable surface: it only keeps the SqlAdapter name so the registry
 * shape typechecks until V3-14 replaces this file with the real
 * typed-operation interface. Do not add execute/select/load methods
 * here; do not reintroduce QueryResult or SqlDatabase.
 */
export interface SqlAdapter {
  /**
   * Marker property only. There is intentionally no callable surface
   * until the typed-operation interface lands (wave 3, V3-14).
   */
  readonly __sqlAdapterStub: true;
}
