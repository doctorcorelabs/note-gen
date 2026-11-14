// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import type { UnlistenFn } from "../event/interface";

/**
 * Store adapter interface for the web fork.
 *
 * Reconciles design V1-02 (fase1/desain-store-adapter.md, the detailed
 * StoreAdapter design) with design V1-05 (fase1/desain-registry-shim.md,
 * the registry foundation design). V1-05 inventories the store surface
 * and fixes the registry mechanics but does not define the StoreHandle
 * shape, StoreOptions, or key classification; V1-02 defines all of
 * those from the installed plugin-store 2.3.0 surface.
 * This file therefore adopts the V1-02 surface and the V1-05 registry
 * placement (one interface.ts per adapter subdirectory, no per
 * subdirectory index.ts, callers import through the registry only).
 *
 * Every difference between V1-02 and V1-05 that affects this file, and
 * the decision taken, is recorded in
 * fase1/laporan-store-interface.md (reconciliation table). In short:
 *
 * - Full IStore surface (V1-02 section 3.3), including reload, length,
 *   onKeyChange, close, and the read-only path field, which the V1-05
 *   inventory summary omits. V1-05 section 1.1 is an inventory summary,
 *   not an exhaustive interface specification.
 * - StoreOptions from V1-02 section 3.5. V1-05 does not define options.
 * - Key classification types from V1-02 section 2. The classification
 *   data itself lives in key-schema.ts (wave 3); this file only carries
 *   the StoreKeyClass type so implementations and the fake share one
 *   vocabulary.
 * - Error behavior is documented here but the error classes live in
 *   ../errors.ts (skeleton landed at a28fd02). This file must not
 *   redefine them. The skeleton error constructor differs from both
 *   designs; see the reconciliation table in the report.
 * - Cross-tab transport (BroadcastChannel in V1-02 section 3.7 versus
 *   the WebSocket watcher in V1-05 section 1.1) is an implementation
 *   detail. This interface only fixes the listener signatures.
 * - Persistence semantics follow V1-02 sections 5.1 and 5.2
 *   (F1-22: set(key, undefined) deletes, temporary pending the Rust
 *   confirmation; F1-23: queue plus server confirmation, save() flushes
 *   and waits). V1-05 only says "explicit flush" and does not decide
 *   either point.
 *
 * This file has no runtime dependency on any adapter implementation
 * and must never import Tauri packages or any *.tauri.ts / *.web.ts
 * module. Implementations live beside it (store.tauri.ts,
 * store.web.ts) and the test fake lives in store.fake.ts.
 *
 * Merge M6 reconciliation (audit V2-40): UnlistenFn is imported
 * from ../event/interface (single definition, K-22); StoreOptions
 * uses the interface form from G0 (same fields); createLazyStore
 * moved to store/lazy.ts so this file stays type-only.
 */

export interface StoreOptions {
  autoSave?: boolean | number;
  serializeFnName?: string;
  deserializeFnName?: string;
  createNew?: boolean;
}


/**
 * Key classification from V1-02 section 2.3.
 *
 * S: server-synchronized settings. R: server-side secret, never visible
 * from the browser. L: device-local state. R_REJECT: class R with no
 * write endpoint in Fase 1, so set() throws PlatformCapabilityError
 * while reads behave as if the key does not exist. UNKNOWN: not known
 * to the key schema; reads are tolerant, writes throw a validation
 * error (enforced by key-schema.ts and the web adapter, not by this
 * interface).
 */
export type StoreKeyClass = "S" | "R" | "L" | "R_REJECT" | "UNKNOWN";

export interface StoreAdapter {
  load(path: string, options?: StoreOptions): Promise<StoreHandle>;
  getStore(path: string): Promise<StoreHandle | null>;
  closeAll(): Promise<void>;
}

export interface StoreHandle {
  readonly path: string;

  /**
   * Returns the value for the key, or undefined when the key does not
   * exist. Class R and R_REJECT keys always return undefined. The
   * returned value is a deep clone; mutating it must not affect the
   * stored document. Never throws for a missing key.
   */
  get<T>(key: string): Promise<T | undefined>;

  /**
   * Updates the cache immediately (visible to the next get() without
   * waiting for save()), fires listeners, and queues the write.
   * set(key, undefined) deletes the key (F1-22 temporary decision,
   * V1-02 section 5.1, pending confirmation against the Rust plugin).
   * set() on an R_REJECT key or on "pin" throws
   * PlatformCapabilityError and leaves the cache unchanged. set() on a
   * key unknown to the schema throws a validation error and leaves
   * the cache unchanged. set() never waits for the network; network
   * failures surface from save() or from a background flush.
   */
  set(key: string, value: unknown): Promise<void>;

  /** True when the key exists in the S plus L cache, including an explicitly stored null. Class R and R_REJECT keys are always false. */
  has(key: string): Promise<boolean>;

  /**
   * Deletes the key from the cache, fires listeners with undefined,
   * and queues the deletion. Returns true when the key existed before
   * the call, false otherwise. delete() on an R_REJECT key returns
   * false without throwing.
   */
  delete(key: string): Promise<boolean>;

  /**
   * Deletes all S and L keys on this handle, fires listeners with
   * undefined per key, and queues deletion of the whole document
   * (including the ai_provider secrets in the web adapter, V1-02
   * section 3.4). Does not wait for server confirmation; save()
   * waits for it.
   */
  clear(): Promise<void>;

  /**
   * Identical to clear() in the web fork: no default document is
   * registered, matching the plugin-store docstring for the case
   * where no default value has been set.
   */
  reset(): Promise<void>;

  /**
   * Combined S plus L keys from the cache. Class R keys are never
   * listed. Order is not guaranteed; callers must not depend on it.
   * Returns a fresh array on every call.
   */
  keys(): Promise<string[]>;

  /** Deep-cloned values for the combined S plus L cache, in the same order as keys() from the same call. Order across calls is not guaranteed. */
  values<T>(): Promise<T[]>;

  /** Deep-cloned [key, value] pairs for the combined S plus L cache. */
  entries<T>(): Promise<Array<[string, T]>>;

  /** Number of combined S plus L keys in the cache. */
  length(): Promise<number>;

  /**
   * Flushes pending writes first (throwing and leaving the cache
   * unchanged when the flush fails), then reloads the S document from
   * the server and re-reads the L document, replacing the cache, and
   * does NOT fire change listeners.
   */
  reload(): Promise<void>;

  /**
   * Flushes the write queue and waits for server confirmation. On
   * success the queue is clean and the call resolves. On failure it
   * throws a typed error and the queue is kept for retry. A handle
   * with no pending changes resolves immediately without a request.
   */
  save(): Promise<void>;

  /**
   * Registers a listener for one key. The callback receives the new
   * value (cloned) or undefined when the key is deleted. Fired by
   * local set/delete/clear/reset, by cross-tab changes, and by
   * rollback after a server rejection. Never fired by reload(). A
   * listener that throws must not break set(): the error is recorded
   * and the remaining listeners still run.
   */
  onKeyChange<T>(
    key: string,
    cb: (value: T | undefined) => void,
  ): Promise<UnlistenFn>;

  /** Like onKeyChange, for all keys. The callback receives (key, value). */
  onChange<T>(
    cb: (key: string, value: T | undefined) => void,
  ): Promise<UnlistenFn>;

  /**
   * Flushes pending writes first. When the flush fails, close()
   * throws and the handle stays usable. When it succeeds, listeners
   * are removed, the handle leaves the adapter cache, and any later
   * method call throws. A second close() is a no-op.
   */
  close(): Promise<void>;
}

/**
 * Web-only extensions (V1-02 section 3.7). Only the web adapter
 * implements these; callers reach them through a type narrowing, never
 * from code migrated from Store without a capability check.
 */
export interface StoreHandleWebExtensions {
  pendingCount(): number;
  lastRevision(): number | null;
  lastFlushError(): Error | null;
  onPersistenceChange(cb: (state: PersistenceState) => void): UnlistenFn;
}

export type PersistenceState =
  | { status: "clean" }
  | { status: "dirty"; pendingKeys: number }
  | { status: "flushing"; pendingKeys: number }
  | { status: "error"; pendingKeys: number; error: Error };
