// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * In-memory fake StoreAdapter for tests and contract suites.
 *
 * This fake is an independent implementation of the StoreHandle
 * interface in interface.ts. It is NOT a wrapper over the web adapter
 * (which does not exist yet; wave 3 builds it with a backend) and it
 * performs no I/O: no HTTP, no localStorage, no timers, no persistence
 * across processes. It exists so behavior contracts can be exercised
 * locally at full speed, following desain-pengujian section 2.1
 * (the fake column of the parameterized contract suite).
 *
 * Enforcement the fake DOES provide (V1-02, desain-store-adapter.md):
 *
 * - Class R keys behave as if they do not exist for get/has/keys/
 *   values/entries/length, and delete() returns false (section 2.2).
 * - set() on an R-MVP-REJECT key throws PlatformCapabilityError and
 *   leaves the cache unchanged (sections 2.3 rule 4, 2.5, 2.10).
 * - set(key, undefined) throws a validation error
 *   (PlatformCapabilityError, invalid_argument) and leaves the key
 *   unchanged (F1-22 H3, AD-106). Callers delete with delete().
 * - A nested undefined field inside an object value is dropped at
 *   the set() boundary and an undefined array element becomes null,
 *   matching the JSON wire form (F1-22 step 3, W4-F122Q), exactly
 *   like the web adapter.
 * - aiModelList entries are stored with their secret-bearing fields
 *   stripped (section 2.7). The fake never stores apiKey,
 *   webSearchApiKey, webSearchApiKeys, or customHeaders, and never
 *   returns them. It does not synthesize hasApiKey/updatedAt metadata;
 *   that enrichment belongs to the web adapter and its secret
 *   endpoint.
 * - Only store.json can be loaded. Every other file name throws
 *   PlatformCapabilityError, following the fail-closed file routing
 *   in section 2.8. getStore() never throws and returns null for a
 *   file that has not been loaded.
 * - Custom serializer options throw PlatformCapabilityError
 *   (section 3.5). There is no Rust side in the web fork.
 * - Deep clone in both directions, immediate visibility of set()
 *   without save(), listeners fired by set/delete/clear/reset and
 *   never by reload(), a throwing listener never breaking set(), and
 *   methods after close() throwing (section 3.4).
 *
 * Simplifications the fake does NOT provide (documented, not hidden):
 *
 * - No key schema. The fake accepts every non-secret key as storable.
 *   It cannot enforce the UNKNOWN-key rule (section 2.3 rule 10:
 *   writes throw a validation error) because key-schema.ts is wave 3
 *   work. The classification data in this file is a frozen snapshot
 *   of the V1-02 reject set and sensitive patterns, kept here only so
 *   the fake can enforce the secret rules. key-schema.ts is the
 *   canonical owner once it lands; this snapshot must then be checked
 *   against it, not extended independently.
 * - No S/L split. The fake stores one document per handle and does
 *   not distinguish server settings from device-local state.
 * - save() and reload() resolve immediately: the document is already
 *   in memory, so there is nothing to flush or reload. The queue,
 *   revision guard, and conflict behavior of sections 4.2 and 5.2
 *   belong to the web adapter and its contract tests (CT-14, CT-15).
 * - Listeners are local only. No BroadcastChannel and no revision
 *   polling (section 3.7). Cross-tab behavior is a web-adapter
 *   contract (CT-18).
 * - A listener notification for a delete is only sent when the key
 *   existed. Deleting an absent key is silent, matching the false
 *   return value. V1-02 does not state this edge explicitly.
 *
 * Error construction uses the landed errors.ts skeleton (../errors),
 * imported as required. The skeleton constructor differs from both
 * designs; see fase1/laporan-store-interface.md for the
 * reconciliation. The closed-handle error has no typed code in the
 * skeleton (V1-02 wants NOT_FOUND), so the fake throws a plain Error
 * whose message names the closed handle. Wave 3 must revisit this
 * once errors.ts gains the full code taxonomy.
 */

import { capabilityError } from "../errors";
import type { UnlistenFn } from "../event/interface";
import type {
  StoreAdapter,
  StoreHandle,
  StoreOptions,
} from "./interface";

/** The only store file the fake loads (V1-02 section 2.8). */
export const FAKE_SUPPORTED_STORE_PATH = "store.json";

/**
 * R-MVP-REJECT keys (V1-02 section 2.5 table plus section 2.10):
 * class R with no Fase 1 write endpoint. Frozen snapshot; the
 * canonical list lives in key-schema.ts once wave 3 lands it.
 */
export const R_MVP_REJECT_KEYS: readonly string[] = [
  "s3SyncConfig",
  "webdavSyncConfig",
  "imageHostingConfig",
  "s3Config",
  "smms",
  "picgo",
  "lskyImageConfig",
  "webdavImageConfig",
  "customHttpImageConfig",
  "cloudinaryImageConfig",
  "imageKitImageConfig",
  "qiniuImageConfig",
  "upyunImageConfig",
  "mcpServers",
  "mcp.servers",
  "pin",
  "oneDriveAuthTokens",
  "pendingOneDriveConfig",
];

/**
 * Sensitive-name patterns from upstream sync-exclusions.ts, applied as
 * lowercase substrings (V1-02 section 2.3 rule 4). Any key matching
 * one of these is treated as class R and therefore rejected by this
 * fake, even when the key also appears in a device-local list.
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "apikey",
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "password",
  "secret",
  "token",
  "credential",
];

/** Secret-bearing fields of one AiConfig entry (V1-02 section 2.7). */
export const AI_MODEL_LIST_SECRET_FIELDS: readonly string[] = [
  "apiKey",
  "webSearchApiKey",
  "webSearchApiKeys",
  "customHeaders",
];

export type FakeKeyDisposition = "stored" | "rejected-secret" | "split-ai-model-list";

const rejectSet = new Set<string>(R_MVP_REJECT_KEYS);

/**
 * Classifies one key for fake enforcement only. Colon-scoped keys
 * inherit the classification of their base (V1-02 section 2.3 rules
 * 6 and 8); a colon-scoped aiModelList variant is rejected fail-closed
 * because field splitting is only defined for the exact key.
 */
export function classifyFakeKey(key: string): FakeKeyDisposition {
  if (key === "aiModelList") {
    return "split-ai-model-list";
  }
  const base = key.split(":")[0] as string;
  if (rejectSet.has(key) || rejectSet.has(base)) {
    return "rejected-secret";
  }
  if (base === "aiModelList") {
    return "rejected-secret";
  }
  const lowered = key.toLowerCase();
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (lowered.includes(pattern)) {
      return "rejected-secret";
    }
  }
  return "stored";
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/**
 * Nested-undefined rule (F1-22 step 3, W4-F122Q), identical to the
 * web adapter: undefined-valued fields are dropped from plain
 * objects (recursively) and undefined array elements become null
 * (recursively), matching the JSON wire form. The caller's object is
 * never mutated. See normalizeNestedUndefined in store.web.ts.
 */
function normalizeNestedUndefined<T>(
  value: T,
  seen: WeakSet<object> = new WeakSet(),
): T {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
    let changed = false;
    const out = value.map((item) => {
      if (item === undefined) {
        changed = true;
        return null;
      }
      const next = normalizeNestedUndefined(item, seen);
      if (next !== item) {
        changed = true;
      }
      return next;
    });
    return (changed ? out : value) as T;
  }
  if (typeof value === "object" && value !== null) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
    let changed = false;
    const out: Record<string, unknown> = Object.create(proto) as Record<
      string,
      unknown
    >;
    for (const [field, fieldValue] of Object.entries(value)) {
      if (fieldValue === undefined) {
        changed = true;
        continue;
      }
      const next = normalizeNestedUndefined(fieldValue, seen);
      if (next !== fieldValue) {
        changed = true;
      }
      out[field] = next;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

function stripAiModelListSecrets(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return cloneValue(value);
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return cloneValue(entry);
    }
    const copy: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
    for (const field of AI_MODEL_LIST_SECRET_FIELDS) {
      delete copy[field];
    }
    return copy;
  });
}

type ChangeListener = (key: string, value: unknown) => void;
type KeyListener = (value: unknown) => void;

class FakeStoreHandle implements StoreHandle {
  readonly path: string;
  private readonly data = new Map<string, unknown>();
  private readonly keyListeners = new Map<string, Set<KeyListener>>();
  private readonly changeListeners = new Set<ChangeListener>();
  private closed = false;
  private readonly onClose: () => void;

  constructor(path: string, onClose: () => void) {
    this.path = path;
    this.onClose = onClose;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Store handle for "${this.path}" is closed`);
    }
  }

  private notify(key: string, value: unknown): void {
    const forKey = this.keyListeners.get(key);
    if (forKey) {
      for (const listener of [...forKey]) {
        try {
          listener(cloneValue(value));
        } catch {
          // A throwing listener must not break set()/delete().
        }
      }
    }
    for (const listener of [...this.changeListeners]) {
      try {
        listener(key, cloneValue(value));
      } catch {
        // A throwing listener must not break set()/delete().
      }
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.assertOpen();
    if (classifyFakeKey(key) === "rejected-secret") {
      return undefined;
    }
    if (!this.data.has(key)) {
      return undefined;
    }
    return cloneValue(this.data.get(key)) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.assertOpen();
    const disposition = classifyFakeKey(key);
    if (disposition === "rejected-secret") {
      throw capabilityError(
        "unavailable",
        "store",
        "store.setSecretKey",
        "web",
        `Key "${key}" is a server-side secret with no Fase 1 write endpoint; ` +
          `reads behave as if the key does not exist`,
      );
    }
    if (value === undefined) {
      // H3 (AD-106): reject and leave the key unchanged, matching
      // the web adapter. Callers delete with delete().
      throw capabilityError(
        "invalid_argument",
        "store",
        "store.set",
        "web",
        `set() does not accept undefined for key "${key}"; use delete() to remove a key (F1-22 H3, AD-106)`,
      );
    }
    const stored =
      disposition === "split-ai-model-list"
        ? stripAiModelListSecrets(normalizeNestedUndefined(value))
        : cloneValue(normalizeNestedUndefined(value));
    this.data.set(key, stored);
    this.notify(key, stored);
  }

  async has(key: string): Promise<boolean> {
    this.assertOpen();
    if (classifyFakeKey(key) === "rejected-secret") {
      return false;
    }
    return this.data.has(key);
  }

  async delete(key: string): Promise<boolean> {
    this.assertOpen();
    if (classifyFakeKey(key) === "rejected-secret") {
      return false;
    }
    const existed = this.data.delete(key);
    if (existed) {
      this.notify(key, undefined);
    }
    return existed;
  }

  async clear(): Promise<void> {
    this.assertOpen();
    const keys = [...this.data.keys()];
    this.data.clear();
    for (const key of keys) {
      this.notify(key, undefined);
    }
  }

  async reset(): Promise<void> {
    await this.clear();
  }

  async keys(): Promise<string[]> {
    this.assertOpen();
    return [...this.data.keys()];
  }

  async values<T>(): Promise<T[]> {
    this.assertOpen();
    return [...this.data.values()].map((value) => cloneValue(value) as T);
  }

  async entries<T>(): Promise<Array<[string, T]>> {
    this.assertOpen();
    return [...this.data.entries()].map(
      ([key, value]) => [key, cloneValue(value) as T] as [string, T],
    );
  }

  async length(): Promise<number> {
    this.assertOpen();
    return this.data.size;
  }

  async reload(): Promise<void> {
    this.assertOpen();
    // No external source exists for the fake; nothing to reload, and
    // reload() never fires listeners (V1-02 section 3.4).
  }

  async save(): Promise<void> {
    this.assertOpen();
    // In-memory only: there is no queue to flush and no server to
    // confirm. The web adapter implements the F1-23 semantics.
  }

  async onKeyChange<T>(
    key: string,
    cb: (value: T | undefined) => void,
  ): Promise<UnlistenFn> {
    this.assertOpen();
    const listener: KeyListener = (value: unknown) => {
      cb(value as T | undefined);
    };
    let listeners = this.keyListeners.get(key);
    if (!listeners) {
      listeners = new Set<KeyListener>();
      this.keyListeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async onChange<T>(
    cb: (key: string, value: T | undefined) => void,
  ): Promise<UnlistenFn> {
    this.assertOpen();
    const listener: ChangeListener = (key: string, value: unknown) => {
      cb(key, value as T | undefined);
    };
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.keyListeners.clear();
    this.changeListeners.clear();
    this.onClose();
  }
}

class FakeStoreAdapter implements StoreAdapter {
  private readonly handles = new Map<string, FakeStoreHandle>();

  async load(path: string, options?: StoreOptions): Promise<StoreHandle> {
    if (options?.serializeFnName !== undefined || options?.deserializeFnName !== undefined) {
      throw capabilityError(
        "unsupported",
        "store",
        "store.customSerializer",
        "web",
        "Custom serializer functions are registered on the Rust side and have no web equivalent",
      );
    }
    if (path !== FAKE_SUPPORTED_STORE_PATH) {
      throw capabilityError(
        "unavailable",
        "store",
        "store.loadRemovedFile",
        "web",
        `Store file "${path}" is not available in the web fork; only "${FAKE_SUPPORTED_STORE_PATH}" is supported`,
      );
    }
    const existing = this.handles.get(path);
    if (existing) {
      if (options?.createNew === true) {
        await existing.clear();
      }
      return existing;
    }
    const handle = new FakeStoreHandle(path, () => {
      this.handles.delete(path);
    });
    this.handles.set(path, handle);
    return handle;
  }

  async getStore(path: string): Promise<StoreHandle | null> {
    return this.handles.get(path) ?? null;
  }

  async closeAll(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    for (const handle of handles) {
      await handle.close();
    }
  }
}

/** Creates a fresh fake adapter with an empty per-file handle cache. */
export function createFakeStoreAdapter(): StoreAdapter {
  return new FakeStoreAdapter();
}
