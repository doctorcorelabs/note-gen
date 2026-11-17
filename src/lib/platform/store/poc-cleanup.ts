// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * POC key cleanup (V1-02 section 6.2, 3E-STOREWIRE follow-up).
 *
 * Browsers that ran the Fase 0 POC build keep one JSON document per
 * store file under the POC prefix in localStorage. Those documents
 * may hold plaintext secrets, so their values are never migrated:
 * this module deletes the keys without ever reading a value, once
 * per boot, before the first load() and before any device-local
 * document is read. The web adapter never reads the POC prefix
 * itself (store.web.ts header); without this module the keys would
 * stay forever.
 *
 * Specification (rencana-v312.md section 5, faithful to the design):
 *
 * 1. Scan every localStorage key; delete each key that starts with
 *    exactly the POC prefix. Matching is an exact prefix test, never
 *    a substring test, so no other key is touched.
 * 2. Never read a POC value: enumeration plus removal only. The log
 *    records how many keys were removed, nothing else: no key names
 *    and no values. No log line is written when nothing was removed.
 * 3. Never touch the new device-local prefix or any other key. The
 *    CT-16 cases pin that the new prefix and unrelated keys survive.
 * 4. Runs once per boot, before the first load(), regardless of auth
 *    status. On a browser without POC keys the scan finds nothing
 *    and does nothing.
 * 5. No UI and no confirmation: POC keys are test artifacts with
 *    clear ownership (prefix plus POC header), not user data.
 * 6. This code is kept in Fase 1 and afterwards. Removing it is a
 *    separate hygiene item, not part of the shim removal.
 *
 * Failure behavior: cleanup must never break boot. Unavailable or
 * throwing storage yields 0 removals and no throw; a removal that
 * throws for one key does not stop the remaining keys. The removal
 * list is snapshotted before any removal, because removing while
 * enumerating forward would shift indices and skip keys.
 */

/**
 * The POC prefix, the single allowed occurrence of this literal in
 * production code (gate G2 excepts this constant and its test).
 * The device-local prefix lives in store.web.ts and is never named
 * here, so this module cannot confuse the two.
 */
export const POC_STORAGE_PREFIX = "notegen-poc-store:";

/**
 * Minimal storage surface cleanup needs: enumeration plus removal.
 * Deliberately limited to those two operations: cleanup never reads
 * a value, so no read method appears here. The DOM Storage type
 * satisfies this surface.
 */
export interface PocCleanupStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

function resolveStorage(
  requested: PocCleanupStorage | null | undefined,
): PocCleanupStorage | null {
  if (requested !== undefined) {
    return requested;
  }
  try {
    const candidate = (globalThis as { localStorage?: unknown }).localStorage;
    if (
      candidate !== null &&
      candidate !== undefined &&
      typeof (candidate as PocCleanupStorage).key === "function" &&
      typeof (candidate as PocCleanupStorage).removeItem === "function"
    ) {
      return candidate as PocCleanupStorage;
    }
  } catch {
    // Storage access can throw when blocked; treat it as absent.
  }
  return null;
}

/**
 * Delete every key under the POC prefix. Returns the number of keys
 * actually removed. Pass an explicit storage for tests, or null to
 * force the no-storage path; with no argument the global
 * localStorage is used when present. Never throws. See the module
 * header for the log rule.
 */
export function runPocCleanup(
  storage?: PocCleanupStorage | null,
): number {
  const target = resolveStorage(storage);
  if (target === null) {
    return 0;
  }
  let toRemove: string[];
  try {
    toRemove = [];
    const count = target.length;
    for (let index = 0; index < count; index += 1) {
      const name = target.key(index);
      if (name !== null && name.startsWith(POC_STORAGE_PREFIX)) {
        toRemove.push(name);
      }
    }
  } catch {
    // Enumeration failed before any removal; nothing was deleted.
    return 0;
  }
  let removed = 0;
  for (const name of toRemove) {
    try {
      target.removeItem(name);
      removed += 1;
    } catch {
      // One failed removal must not stop the rest or break boot.
    }
  }
  if (removed > 0) {
    try {
      console.info(`NoteGen store: removed ${removed} legacy POC keys`);
    } catch {
      // Logging must never break boot.
    }
  }
  return removed;
}

let cleanupRan = false;

/**
 * Boot seam: run the cleanup at most once per page lifetime. Later
 * calls return 0 without scanning, so repeated boot entry points
 * cannot rescan. Boot passes no storage argument; the explicit
 * storage parameter exists for tests only.
 */
export function runPocCleanupOnce(
  storage?: PocCleanupStorage | null,
): number {
  if (cleanupRan) {
    return 0;
  }
  cleanupRan = true;
  return runPocCleanup(storage);
}

/**
 * Test-only reset for the once flag. Production code must never call
 * this function.
 */
export function __resetPocCleanupOnceForTests(): void {
  cleanupRan = false;
}
