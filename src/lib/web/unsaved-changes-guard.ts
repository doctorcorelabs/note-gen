// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unsaved-changes unload guard (G28, S-P0-18).
 *
 * The editor save chain has a double debounce window (about 500 ms in
 * TipTap plus 500 ms in the article store) plus HTTP time. Closing the
 * browser tab inside that window used to lose keystrokes without any
 * warning: no `beforeunload` handler existed anywhere in `src/`.
 *
 * This module is a small registry, not an editor feature. Probes report
 * whether unsaved work exists; flushers push pending work toward the
 * store/server. Registration order is preserved (Map insertion order),
 * so an editor flush registered before a store flush runs first and
 * the store flush then drains what the editor just queued.
 *
 * `beforeunload` only prompts while a probe reports unsaved work, so a
 * clean document never shows a spurious warning. The `pagehide` and
 * `visibilitychange` flushes are best-effort mitigations, not a
 * guarantee: the browser may terminate a fetch during unload, and a
 * browser crash runs no handler at all. The honest save status in the
 * article store remains the source of truth after any unload.
 *
 * The module touches no DOM at import time and is safe to import on
 * the server: `installUnsavedChangesUnloadGuard` is a no-op without
 * `window`.
 */

export type UnsavedChangesProbe = () => boolean
export type UnsavedChangesFlush = () => unknown | Promise<unknown>

const probes = new Map<string, UnsavedChangesProbe>()
const flushers = new Map<string, UnsavedChangesFlush>()

export function registerUnsavedChangesProbe(
  id: string,
  probe: UnsavedChangesProbe,
): () => void {
  probes.set(id, probe)
  return () => {
    if (probes.get(id) === probe) {
      probes.delete(id)
    }
  }
}

export function registerUnsavedChangesFlush(
  id: string,
  flush: UnsavedChangesFlush,
): () => void {
  flushers.set(id, flush)
  return () => {
    if (flushers.get(id) === flush) {
      flushers.delete(id)
    }
  }
}

/**
 * True when any registered probe reports unsaved work. A throwing
 * probe fails closed (treated as dirty) so a broken probe can never
 * silently waive the unload prompt.
 */
export function hasUnsavedChanges(): boolean {
  for (const probe of probes.values()) {
    try {
      if (probe()) return true
    } catch (error) {
      console.error('Unsaved-changes probe failed; treating as dirty:', error)
      return true
    }
  }
  return false
}

/**
 * Run every registered flusher in registration order, awaiting each
 * one. A failing flusher never stops the later ones. Returns true
 * only when every flusher succeeded.
 */
export async function flushUnsavedChanges(): Promise<boolean> {
  let allSucceeded = true
  for (const flush of flushers.values()) {
    try {
      await flush()
    } catch (error) {
      allSucceeded = false
      console.error('Unsaved-changes flush failed:', error)
    }
  }
  return allSucceeded
}

let unloadGuardInstalled = false

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedChanges()) return
  event.preventDefault()
  // The empty string is the standard cross-browser prompt trigger;
  // browsers ignore any custom message.
  event.returnValue = ''
}

function handlePageHide(): void {
  if (!hasUnsavedChanges()) return
  void flushUnsavedChanges()
}

function handleVisibilityChange(): void {
  if (typeof document === 'undefined' || !document.hidden) return
  if (!hasUnsavedChanges()) return
  void flushUnsavedChanges()
}

/**
 * Install the unload guard exactly once for the page lifetime. The
 * returned uninstaller exists for tests and embedders; editor tabs
 * intentionally never uninstall it, because the guard protects the
 * whole page, not one tab.
 */
export function installUnsavedChangesUnloadGuard(): () => void {
  if (typeof window === 'undefined' || unloadGuardInstalled) {
    return () => {}
  }
  unloadGuardInstalled = true
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('pagehide', handlePageHide)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  return () => {
    window.removeEventListener('beforeunload', handleBeforeUnload)
    window.removeEventListener('pagehide', handlePageHide)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    unloadGuardInstalled = false
  }
}
