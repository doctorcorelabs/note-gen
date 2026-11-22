// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Pure helpers for the workspace file trash panel (F-05-01). Kept
// out of the component so the paging/merge and size formatting
// logic carries deterministic specs (trash-panel-model.spec.ts).

import type { WorkspaceTrashEntry } from '@/lib/platform/invoke/workspace-trash-handler'

/**
 * Append one cursor page to the entries already shown. The server
 * pages by deletedAt descending with id as tie-break, so a stable
 * append is correct; entries whose id is already present are
 * skipped so a reload overlap can never duplicate a row.
 */
export function appendTrashPage(
  existing: readonly WorkspaceTrashEntry[],
  page: readonly WorkspaceTrashEntry[],
): WorkspaceTrashEntry[] {
  const seen = new Set(existing.map(entry => entry.id))
  const merged = [...existing]
  for (const entry of page) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id)
      merged.push(entry)
    }
  }
  return merged
}

/** Drop entries by id (after a restore or purge of those entries). */
export function removeTrashEntries(
  entries: readonly WorkspaceTrashEntry[],
  ids: ReadonlySet<string>,
): WorkspaceTrashEntry[] {
  return entries.filter(entry => !ids.has(entry.id))
}

/** Human-readable byte size for the trash list (B, KB, MB, GB). */
export function formatTrashSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024
    unit = units[i]
  }
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')
  return `${text} ${unit}`
}
