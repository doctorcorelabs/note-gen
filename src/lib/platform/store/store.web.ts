// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web StoreAdapter (V3-11, wave 3B): cache plus write queue plus HTTP,
 * over the three layers of desain-store-adapter.md (V1-02).
 *
 * Layers: S settings come from GET /api/settings and flush through one
 * PATCH per batch with the baseRevision guard (canonical contract,
 * kontrak-api-kanonis.md section 3.2; no /v1 prefix). L device-local
 * state lives in one localStorage document per store path under the
 * `notegen-web-local:` prefix. R secrets are never visible, never
 * stored, and never sent: reads behave as if the key does not exist
 * and writes throw PlatformCapabilityError.
 *
 * Persistence semantics (V1-02 sections 5.1 and 5.2, F1-22/F1-23):
 * set() updates the cache immediately and queues the write; save()
 * flushes the queue and waits for server confirmation; reload()
 * flushes first, then reloads without firing listeners; set(key,
 * undefined) throws a validation error and leaves the key unchanged
 * (H3, AD-106; callers delete with delete()). A flush is serialized
 * through one promise chain, coalesces per key, and keeps the queue
 * on failure for retry.
 *
 * Injected ports (seams for the integrator, wave 3B):
 *
 * - Classification arrives through `classifyKey`, using the
 *   StoreKeyClass vocabulary from interface.ts. The default
 *   classifier (createDefaultStoreKeyClassifier) is a fail-closed
 *   stand-in: it rejects the frozen V1-02 secret set and the
 *   sensitive-name patterns, and calls everything else S. It does
 *   NOT know the L list, the known-S list, or UNKNOWN. Production
 *   wiring MUST inject the classifyKey from key-schema.ts (sibling
 *   task v3b-11b) so L keys route to localStorage and UNKNOWN writes
 *   throw. The adapter already enforces all five classes; only the
 *   data is injected.
 * - Transport arrives through `fetchImpl`, a minimal fetch surface.
 *   The default uses the global fetch with same-origin credentials
 *   and attaches X-CSRF-Token from the injected `getCsrfToken`
 *   provider on mutations. The V3-30a/b API client and CSRF wiring
 *   are unmerged, so this module deliberately does NOT import any
 *   shared client; the integrator replaces fetchImpl/getCsrfToken
 *   with the shared client when it lands. Endpoint paths, the
 *   Idempotency-Key header, and the success/error envelope shapes
 *   follow the canonical contract and the landed server routes.
 * - Storage arrives through `storage`, a minimal localStorage
 *   surface. The default uses globalThis.localStorage when present
 *   and falls back to an in-memory document otherwise.
 * - Cross-tab notification uses BroadcastChannel when available
 *   (V1-02 section 3.7): after a confirmed flush the handle posts
 *   key names plus the new revision, never values. A receiving tab
 *   refetches and fires listeners for changed keys, unless it has
 *   pending writes. Revision polling on visibilitychange (the
 *   cross-device path in section 3.7) is NOT implemented here; it
 *   belongs to the wiring layer, which can call reload().
 *
 * Flush order deviation, recorded explicitly: V1-02 section 2.7
 * orders a flush as secrets PUT first, then settings PATCH. The
 * landed server rejects a secret PUT for a provider with no
 * metadata entry yet, so a new provider written through one flush
 * would fail secret-first. This adapter therefore sends PATCH first
 * and PUT second. No false-complete state arises: the server
 * computes hasApiKey from secret existence on read, so a provider
 * whose PUT failed reads back as keyless, and the secret queue is
 * kept for retry while the confirmed S queue is cleared.
 *
 * POC cleanup (poc-cleanup.ts, V1-02 section 6.2) is NOT done here:
 * it is a separate module owned by the integrator, run once per boot
 * before the first load(). This adapter never reads keys under the
 * POC prefix.
 *
 * Error taxonomy: capability failures use PlatformCapabilityError
 * from ../errors.ts (the landed skeleton; see
 * fase1/laporan-store-interface.md R-03). Client-side validation
 * rejections (unknown keys, undefined values) also use
 * PlatformCapabilityError with code invalid_argument, the landed
 * form of the V1-02 VALIDATION_ERROR code. Operational failures
 * (HTTP, network, storage, conflicts) use StoreWebError below,
 * following the FsAdapterError precedent in ../fs/errors.ts: the
 * wire code is carried verbatim, never invented, and no error ever
 * carries a setting value or a secret. A closed handle throws a
 * plain Error with the same message as the fake, because the landed
 * error skeleton has no NOT_FOUND code yet.
 */

import { capabilityError } from "../errors";
import type { UnlistenFn } from "../event/interface";
import type {
  PersistenceState,
  StoreAdapter,
  StoreHandle,
  StoreHandleWebExtensions,
  StoreKeyClass,
  StoreOptions,
} from "./interface";

/** The only store file the web adapter loads (V1-02 section 2.8). */
export const WEB_SUPPORTED_STORE_PATH = "store.json";

/** localStorage prefix for the L document (V1-02 section 2.9). */
export const WEB_LOCAL_STORAGE_PREFIX = "notegen-web-local:";

/** BroadcastChannel name prefix for cross-tab change notices. */
export const WEB_BROADCAST_PREFIX = "notegen-store:";

const SETTINGS_URL = "/api/settings";
const SECRETS_PUT_URL = "/api/settings/secrets/ai-providers";
const IDEMPOTENCY_HEADER = "Idempotency-Key";
const CSRF_HEADER = "X-CSRF-Token";

/** Coalescing window after the last mutation (V1-02 section 5.2). */
const DEFAULT_COALESCE_MS = 250;
/** Maximum time a batch waits for coalescing (V1-02 section 5.2). */
const DEFAULT_MAX_WAIT_MS = 2000;
/** Maximum unique queued entries per handle (V1-02 section 5.2). */
const MAX_QUEUE_ENTRIES = 500;
/** Maximum consecutive failed background flushes before waiting. */
const MAX_BACKGROUND_FAILURES = 3;

/**
 * R-MVP-REJECT keys (V1-02 section 2.5 table plus section 2.10).
 * Frozen snapshot, same provenance as the one in store.fake.ts; the
 * canonical list lives in key-schema.ts once it lands. This snapshot
 * must be checked against key-schema.ts then, not extended alone.
 */
export const WEB_R_REJECT_KEYS: readonly string[] = [
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
 * Sensitive-name patterns from upstream sync-exclusions.ts, applied
 * as lowercase substrings (V1-02 section 2.3 rule 4).
 */
export const WEB_SENSITIVE_KEY_PATTERNS: readonly string[] = [
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
export const WEB_AI_MODEL_LIST_SECRET_FIELDS: readonly string[] = [
  "apiKey",
  "webSearchApiKey",
  "webSearchApiKeys",
  "customHeaders",
];

/**
 * Classification port. Sibling task v3b-11b (key-schema.ts) provides
 * the production implementation; the default below is a stand-in.
 */
export type StoreKeyClassifier = (key: string) => StoreKeyClass;

/**
 * Default classifier: fail-closed on secrets, S for everything else.
 * Colon-scoped keys inherit the base classification (V1-02 section
 * 2.3 rules 6 and 8); a colon-scoped aiModelList variant is rejected
 * fail-closed because field splitting is only defined for the exact
 * key. This classifier never returns L or UNKNOWN: production wiring
 * must inject the key-schema classifier for those classes.
 */
export function createDefaultStoreKeyClassifier(): StoreKeyClassifier {
  const rejectSet = new Set<string>(WEB_R_REJECT_KEYS);
  return (key: string): StoreKeyClass => {
    const base = key.split(":")[0] as string;
    if (rejectSet.has(key) || rejectSet.has(base)) {
      return "R_REJECT";
    }
    if (base === "aiModelList" && key !== "aiModelList") {
      return "R_REJECT";
    }
    const lowered = key.toLowerCase();
    for (const pattern of WEB_SENSITIVE_KEY_PATTERNS) {
      if (lowered.includes(pattern)) {
        return "R_REJECT";
      }
    }
    return "S";
  };
}

/** Minimal fetch surface, so tests can inject a fake without DOM types. */
export interface StoreWebFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface StoreWebFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  credentials?: string;
}

export type StoreWebFetch = (
  url: string,
  init?: StoreWebFetchInit,
) => Promise<StoreWebFetchResponse>;

/** Minimal localStorage surface, so tests can inject a fake. */
export interface StoreWebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Minimal BroadcastChannel surface, so tests can inject a fake. */
export interface StoreWebBroadcastChannel {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

export type StoreWebBroadcastChannelCtor = new (
  name: string,
) => StoreWebBroadcastChannel;

/** Decoded GET /api/settings payload (canonical contract 3.2). */
export interface SettingsDocument {
  revision: number;
  settings: Record<string, unknown>;
}

/** One rejected key from a PATCH response. */
export interface RejectedSettingKey {
  key: string;
  reason: string;
}

/** Decoded PATCH /api/settings payload (canonical contract 3.2). */
export interface PatchSettingsResult {
  revision: number;
  applied: string[];
  rejected: RejectedSettingKey[];
}

/**
 * One provider entry for PUT /api/settings/secrets/ai-providers.
 * A field that is absent means "leave as is"; null means "delete
 * that field from the bundle" (V1-02 section 4.3).
 */
export interface AiProviderSecretUpdate {
  providerKey: string;
  apiKey?: string | null;
  webSearchApiKey?: string | null;
  webSearchApiKeys?: Record<string, string> | null;
  customHeaders?: Record<string, string> | null;
}

/**
 * Operational web store error. `code` is the wire code verbatim
 * when the server answered, or one of the client-side codes
 * `network_error`, `invalid_response`, `storage_error` when the
 * failure happened before a usable response. `conflict` carries
 * the fresh document from a 409 revision_conflict response when
 * the server supplied one. Messages never carry setting values.
 */
export class StoreWebError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly conflict?: SettingsDocument;

  constructor(opts: {
    code: string;
    status: number;
    message: string;
    retryable?: boolean;
    requestId?: string;
    conflict?: SettingsDocument;
  }) {
    super(opts.message);
    this.name = "StoreWebError";
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.requestId = opts.requestId;
    this.conflict = opts.conflict;
  }
}

export function isStoreWebError(err: unknown): err is StoreWebError {
  return err instanceof StoreWebError;
}

export function isRevisionConflictError(
  err: unknown,
): err is StoreWebError {
  return isStoreWebError(err) && err.code === "revision_conflict";
}

export interface WebStoreAdapterDeps {
  /** Fetch implementation. Defaults to the global fetch. */
  fetchImpl?: StoreWebFetch;
  /**
   * CSRF token provider for mutations. Return null/undefined when
   * no token is available; the request is then sent without the
   * header and the server answers 403 honestly. Wiring seam for
   * the V3-30a/b auth client, which is unmerged.
   */
  getCsrfToken?: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
  /** Key classifier. Defaults to createDefaultStoreKeyClassifier(). */
  classifyKey?: StoreKeyClassifier;
  /**
   * L-document storage. Defaults to globalThis.localStorage when
   * present, else an in-memory document. Pass null to force the
   * in-memory fallback (SSR, tests).
   */
  storage?: StoreWebStorage | null;
  /**
   * BroadcastChannel constructor for cross-tab notices. Defaults
   * to the global BroadcastChannel when present, else disabled.
   * Pass null to disable explicitly.
   */
  broadcastChannelImpl?: StoreWebBroadcastChannelCtor | null;
  /** Coalescing window in ms. Default 250 (V1-02 section 5.2). */
  coalesceMs?: number;
  /** Maximum coalescing wait in ms. Default 2000. */
  maxWaitMs?: number;
  /** Idempotency key factory. Defaults to crypto.randomUUID(). */
  createIdempotencyKey?: () => string;
}

/** A web store handle: the StoreHandle surface plus web extensions. */
export type WebStoreHandle = StoreHandle & StoreHandleWebExtensions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function warnOnce(flag: { warned: boolean }, message: string): void {
  if (flag.warned) {
    return;
  }
  flag.warned = true;
  try {
    console.warn(message);
  } catch {
    // Logging must never break the store.
  }
}

let idempotencyCounter = 0;

function defaultIdempotencyKey(): string {
  try {
    const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } })
      .crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      return cryptoObj.randomUUID();
    }
  } catch {
    // Fall through to the counter-based key below.
  }
  idempotencyCounter += 1;
  return `notegen-store-${Date.now()}-${idempotencyCounter}-${Math.floor(Math.random() * 1e9)}`;
}

class MemoryStorage implements StoreWebStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function resolveStorage(
  requested: StoreWebStorage | null | undefined,
  fallback: MemoryStorage,
): StoreWebStorage {
  if (requested !== undefined) {
    return requested ?? fallback;
  }
  try {
    const candidate = (globalThis as { localStorage?: unknown }).localStorage;
    if (
      candidate !== null &&
      candidate !== undefined &&
      typeof (candidate as StoreWebStorage).getItem === "function" &&
      typeof (candidate as StoreWebStorage).setItem === "function"
    ) {
      return candidate as StoreWebStorage;
    }
  } catch {
    // Storage access can throw when blocked; fall through to memory.
  }
  return fallback;
}

function resolveBroadcastCtor(
  requested: StoreWebBroadcastChannelCtor | null | undefined,
): StoreWebBroadcastChannelCtor | null {
  if (requested !== undefined) {
    return requested;
  }
  try {
    const candidate = (globalThis as { BroadcastChannel?: unknown })
      .BroadcastChannel;
    if (typeof candidate === "function") {
      return candidate as StoreWebBroadcastChannelCtor;
    }
  } catch {
    // Ignore; cross-tab notices stay disabled.
  }
  return null;
}

function defaultFetchImpl(): StoreWebFetch {
  return (url, init) => {
    const fetchFn = (globalThis as { fetch?: unknown }).fetch;
    if (typeof fetchFn !== "function") {
      return Promise.reject(
        new StoreWebError({
          code: "network_error",
          status: 0,
          message: "No fetch implementation is available in this runtime",
          retryable: false,
        }),
      );
    }
    return (fetchFn as StoreWebFetch)(url, init);
  };
}

/**
 * Splits an aiModelList value into cache-safe metadata plus the
 * secret bundles to send to the secret endpoint (V1-02 section
 * 2.7). Secret fields present on an entry are recorded in the
 * patch (including explicit null, which deletes the field); fields
 * absent from an entry are left out, so the server leaves them as
 * is. Entries without a string `key` cannot address a bundle: their
 * secret fields are still stripped from the metadata and the patch
 * is dropped. Non-array values pass through unstripped, matching
 * the fake: splitting is only defined for the array shape.
 */
function splitAiModelList(value: unknown): {
  metadata: unknown;
  secrets: Map<string, Record<string, unknown>>;
} {
  const secrets = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) {
    return { metadata: cloneValue(value), secrets };
  }
  const metadata = value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return cloneValue(entry);
    }
    const record = entry as Record<string, unknown>;
    const copy: Record<string, unknown> = { ...record };
    const patch: Record<string, unknown> = {};
    for (const field of WEB_AI_MODEL_LIST_SECRET_FIELDS) {
      if (field in record && record[field] !== undefined) {
        patch[field] = cloneValue(record[field]);
      }
      delete copy[field];
    }
    if (
      Object.keys(patch).length > 0 &&
      typeof record["key"] === "string" &&
      record["key"] !== ""
    ) {
      secrets.set(record["key"], patch);
    }
    return copy;
  });
  return { metadata, secrets };
}

function providerKeysOf(metadata: unknown): Set<string> {
  const keys = new Set<string>();
  if (Array.isArray(metadata)) {
    for (const entry of metadata) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>)["key"] === "string"
      ) {
        keys.add((entry as Record<string, unknown>)["key"] as string);
      }
    }
  }
  return keys;
}

type PendingEntry = { op: "set" | "delete"; value?: unknown };
type ChangeListener = (key: string, value: unknown) => void;
type KeyListener = (value: unknown) => void;

interface Transport {
  getSettings(): Promise<SettingsDocument>;
  patchSettings(
    settings: Record<string, unknown>,
    baseRevision: number,
    idempotencyKey: string,
  ): Promise<PatchSettingsResult>;
  putAiProviders(
    providers: readonly AiProviderSecretUpdate[],
    idempotencyKey: string,
  ): Promise<void>;
}

class WebStoreHandleImpl implements WebStoreHandle {
  readonly path: string;
  private readonly classify: StoreKeyClassifier;
  private readonly transport: Transport;
  private readonly storage: StoreWebStorage;
  private readonly storageKey: string;
  private readonly coalesceMs: number;
  private readonly maxWaitMs: number;
  private readonly createIdempotencyKey: () => string;
  private readonly autoSaveEnabled: boolean;
  private readonly onEvict: () => void;
  private readonly storageWarned = { warned: false };

  private readonly sCache = new Map<string, unknown>();
  private readonly lCache = new Map<string, unknown>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly pendingSecrets = new Map<string, Record<string, unknown>>();
  private localDirty = false;
  private revision: number | null = null;
  private lastError: Error | null = null;
  private closed = false;
  private flushing = false;
  private notificationsSuppressed = false;
  private flushChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt: number | null = null;
  private backgroundFailures = 0;
  private readonly keyListeners = new Map<string, Set<KeyListener>>();
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly persistenceListeners = new Set<
    (state: PersistenceState) => void
  >();
  private lastPersistenceSignature: string | null = null;
  private channel: StoreWebBroadcastChannel | null = null;
  private readonly broadcastCtor: StoreWebBroadcastChannelCtor | null;

  constructor(
    path: string,
    options: {
      classify: StoreKeyClassifier;
      transport: Transport;
      storage: StoreWebStorage;
      broadcastCtor: StoreWebBroadcastChannelCtor | null;
      coalesceMs: number;
      maxWaitMs: number;
      createIdempotencyKey: () => string;
      autoSaveEnabled: boolean;
      onEvict: () => void;
    },
  ) {
    this.path = path;
    this.classify = options.classify;
    this.transport = options.transport;
    this.storage = options.storage;
    this.storageKey = `${WEB_LOCAL_STORAGE_PREFIX}${path}`;
    this.broadcastCtor = options.broadcastCtor;
    this.coalesceMs = options.coalesceMs;
    this.maxWaitMs = options.maxWaitMs;
    this.createIdempotencyKey = options.createIdempotencyKey;
    this.autoSaveEnabled = options.autoSaveEnabled;
    this.onEvict = options.onEvict;
  }

  /** Loads the S document and the L document; throws on S failure. */
  async initialize(): Promise<void> {
    const doc = await this.transport.getSettings();
    this.populateServerCache(doc);
    this.populateLocalCache(this.readLocalDocument());
    this.openBroadcastChannel();
  }

  private populateServerCache(doc: SettingsDocument): void {
    this.sCache.clear();
    for (const [key, value] of Object.entries(doc.settings)) {
      const cls = this.classify(key);
      if (cls === "S" || cls === "UNKNOWN") {
        this.sCache.set(key, cloneValue(value));
      }
      // R/R_REJECT/L keys arriving in the S document are dropped:
      // the server document is S-only, and secrets must never enter
      // the cache even if the server mislabels them.
    }
    this.revision = doc.revision;
  }

  private populateLocalCache(doc: Map<string, unknown>): void {
    this.lCache.clear();
    for (const [key, value] of doc) {
      this.lCache.set(key, value);
    }
  }

  private readLocalDocument(): Map<string, unknown> {
    const result = new Map<string, unknown>();
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch (err) {
      warnOnce(
        this.storageWarned,
        `NoteGen store: could not read local document for "${this.path}": ${messageOf(err)}`,
      );
      return result;
    }
    if (raw === null || raw === "") {
      return result;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnOnce(
        this.storageWarned,
        `NoteGen store: corrupt local document for "${this.path}" ignored; starting empty`,
      );
      return result;
    }
    if (!isRecord(parsed)) {
      warnOnce(
        this.storageWarned,
        `NoteGen store: local document for "${this.path}" is not an object; starting empty`,
      );
      return result;
    }
    for (const [key, value] of Object.entries(parsed)) {
      const cls = this.classify(key);
      if (cls === "L") {
        result.set(key, cloneValue(value));
      }
      // Anything else in the L document is dropped: the L document
      // holds L keys only, and secret keys must never surface.
    }
    return result;
  }

  private writeLocalDocument(): void {
    let text: string;
    try {
      text = JSON.stringify(Object.fromEntries(this.lCache));
    } catch (err) {
      throw new StoreWebError({
        code: "invalid_value",
        status: 0,
        message: `Local document for "${this.path}" is not JSON-serializable: ${messageOf(err)}`,
        retryable: false,
      });
    }
    try {
      this.storage.setItem(this.storageKey, text);
    } catch (err) {
      throw new StoreWebError({
        code: "storage_error",
        status: 0,
        message: `Could not write local document for "${this.path}": ${messageOf(err)}`,
        retryable: false,
      });
    }
  }

  private openBroadcastChannel(): void {
    if (this.broadcastCtor === null) {
      return;
    }
    try {
      const channel = new this.broadcastCtor(
        `${WEB_BROADCAST_PREFIX}${this.path}`,
      );
      channel.onmessage = (event: { data: unknown }) => {
        void this.onBroadcastMessage(event.data);
      };
      this.channel = channel;
    } catch {
      this.channel = null;
    }
  }

  private broadcastChange(keys: string[]): void {
    if (this.channel === null || this.revision === null) {
      return;
    }
    try {
      // Key names plus revision only; values never cross the channel.
      this.channel.postMessage({
        type: "notegen-store-changed",
        keys: [...keys],
        revision: this.revision,
      });
    } catch {
      // A failed broadcast must never fail the flush.
    }
  }

  private async onBroadcastMessage(data: unknown): Promise<void> {
    if (this.closed || this.flushing || this.pendingCount() > 0) {
      return;
    }
    if (!isRecord(data) || data["type"] !== "notegen-store-changed") {
      return;
    }
    const revision = data["revision"];
    if (typeof revision !== "number" || revision === this.revision) {
      return;
    }
    let doc: SettingsDocument;
    try {
      doc = await this.transport.getSettings();
    } catch {
      return;
    }
    if (this.closed || this.flushing || this.pendingCount() > 0) {
      return;
    }
    if (doc.revision === this.revision) {
      return;
    }
    const changed = this.applyServerDocument(doc, new Set<string>());
    this.revision = doc.revision;
    for (const [key, value] of changed) {
      this.notify(key, value);
    }
  }

  /**
   * Applies a fresh server document to the S cache, skipping keys
   * in `protectedKeys` (local writes win). Returns the changed keys
   * with their new values (undefined for deletions) for listeners.
   */
  private applyServerDocument(
    doc: SettingsDocument,
    protectedKeys: ReadonlySet<string>,
  ): Array<[string, unknown]> {
    const fresh = new Map<string, unknown>();
    for (const [key, value] of Object.entries(doc.settings)) {
      const cls = this.classify(key);
      if (cls === "S" || cls === "UNKNOWN") {
        fresh.set(key, value);
      }
    }
    const changed: Array<[string, unknown]> = [];
    for (const [key, value] of fresh) {
      if (protectedKeys.has(key)) {
        continue;
      }
      if (!this.sCache.has(key) || !valuesEqual(this.sCache.get(key), value)) {
        this.sCache.set(key, cloneValue(value));
        changed.push([key, cloneValue(value)]);
      }
    }
    for (const key of [...this.sCache.keys()]) {
      if (protectedKeys.has(key) || fresh.has(key)) {
        continue;
      }
      const cls = this.classify(key);
      if (cls !== "S" && cls !== "UNKNOWN") {
        continue;
      }
      this.sCache.delete(key);
      changed.push([key, undefined]);
    }
    return changed;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Store handle for "${this.path}" is closed`);
    }
  }

  private notify(key: string, value: unknown): void {
    if (this.notificationsSuppressed) {
      return;
    }
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

  private persistenceState(): PersistenceState {
    const pendingKeys = this.pendingCount();
    if (this.flushing) {
      return { status: "flushing", pendingKeys };
    }
    if (this.lastError !== null && pendingKeys > 0) {
      return { status: "error", pendingKeys, error: this.lastError };
    }
    if (pendingKeys > 0) {
      return { status: "dirty", pendingKeys };
    }
    return { status: "clean" };
  }

  private emitPersistence(): void {
    const state = this.persistenceState();
    const signature =
      state.status === "error"
        ? `error:${state.pendingKeys}:${state.error.message}`
        : `${state.status}:${state.status === "clean" ? 0 : state.pendingKeys}`;
    if (signature === this.lastPersistenceSignature) {
      return;
    }
    this.lastPersistenceSignature = signature;
    for (const listener of [...this.persistenceListeners]) {
      try {
        listener(state);
      } catch {
        // A throwing persistence listener must not break the store.
      }
    }
  }

  private markDirty(): void {
    if (this.firstPendingAt === null) {
      this.firstPendingAt = Date.now();
    }
    this.emitPersistence();
    this.scheduleBackgroundFlush();
  }

  private scheduleBackgroundFlush(): void {
    if (
      !this.autoSaveEnabled ||
      this.closed ||
      this.flushTimer !== null ||
      this.backgroundFailures >= MAX_BACKGROUND_FAILURES
    ) {
      return;
    }
    if (
      this.firstPendingAt !== null &&
      Date.now() - this.firstPendingAt >= this.maxWaitMs
    ) {
      void this.backgroundFlush();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.backgroundFlush();
    }, this.coalesceMs);
    const timer = this.flushTimer as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  private async backgroundFlush(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.enqueueFlush();
    } catch {
      this.backgroundFailures += 1;
      // No unbounded automatic retry: the next mutation or an
      // explicit save() retries. State already reports the error.
    }
  }

  private clearTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private enqueueFlush(): Promise<void> {
    const run = this.flushChain.then(() => this.flushOnce());
    this.flushChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flushOnce(): Promise<void> {
    if (
      this.pending.size === 0 &&
      this.pendingSecrets.size === 0 &&
      !this.localDirty
    ) {
      return;
    }
    this.flushing = true;
    this.emitPersistence();
    let localError: Error | null = null;
    let flushedKeys: string[] = [];
    let secretsFlushed = false;
    try {
      if (this.localDirty) {
        try {
          this.writeLocalDocument();
          this.localDirty = false;
        } catch (err) {
          localError = err instanceof Error ? err : new Error(String(err));
        }
      }
      if (this.pending.size > 0) {
        const batch = new Map(this.pending);
        const result = await this.patchWithConflictRetry(batch);
        if (result.rejected.length > 0) {
          // Roll rejected keys back to server values (V1-02 4.2.6).
          // The queue is cleared only after the rollback succeeds,
          // so a failed refetch keeps the batch for retry.
          const fresh = await this.transport.getSettings();
          this.revision = fresh.revision;
          for (const entry of result.rejected) {
            const key = entry.key;
            if (key in fresh.settings) {
              this.sCache.set(key, cloneValue(fresh.settings[key]));
              this.notify(key, fresh.settings[key]);
            } else {
              this.sCache.delete(key);
              this.notify(key, undefined);
            }
          }
        } else {
          this.revision = result.revision;
        }
        for (const [key, queued] of batch) {
          if (this.pending.get(key) === queued) {
            this.pending.delete(key);
          }
        }
        flushedKeys = [...batch.keys()];
      }
      if (this.pendingSecrets.size > 0) {
        const secretBatch = new Map(this.pendingSecrets);
        const providers: AiProviderSecretUpdate[] = [...secretBatch.entries()]
          .map(([providerKey, patch]) => ({
            providerKey,
            ...(cloneValue(patch) as Omit<
              AiProviderSecretUpdate,
              "providerKey"
            >),
          }))
          .filter((entry) => Object.keys(entry).length > 1);
        if (providers.length > 0) {
          await this.transport.putAiProviders(
            providers,
            this.createIdempotencyKey(),
          );
        }
        for (const [providerKey, patch] of secretBatch) {
          if (this.pendingSecrets.get(providerKey) === patch) {
            this.pendingSecrets.delete(providerKey);
          }
        }
        secretsFlushed = true;
      }
      if (localError !== null) {
        throw localError;
      }
      this.lastError = null;
      this.backgroundFailures = 0;
      this.firstPendingAt = null;
      if (flushedKeys.length > 0 || secretsFlushed) {
        this.broadcastChange(flushedKeys);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
      throw this.lastError;
    } finally {
      this.flushing = false;
      this.emitPersistence();
    }
  }

  private async patchWithConflictRetry(
    batch: Map<string, PendingEntry>,
  ): Promise<PatchSettingsResult> {
    const idempotencyKey = this.createIdempotencyKey();
    const settings = batchSettings(batch);
    try {
      return await this.transport.patchSettings(
        settings,
        this.revision ?? 0,
        idempotencyKey,
      );
    } catch (err) {
      if (!isRevisionConflictError(err)) {
        throw err;
      }
      const fresh = await this.conflictDocument(err);
      const changed = this.applyServerDocument(
        fresh,
        new Set<string>(batch.keys()),
      );
      this.revision = fresh.revision;
      for (const [key, value] of changed) {
        this.notify(key, value);
      }
      try {
        return await this.transport.patchSettings(
          batchSettings(batch),
          fresh.revision,
          idempotencyKey,
        );
      } catch (retryErr) {
        if (isRevisionConflictError(retryErr)) {
          const latest = await this.bestEffortConflictDocument(retryErr);
          if (latest !== null) {
            const merged = this.applyServerDocument(
              latest,
              new Set<string>(batch.keys()),
            );
            this.revision = latest.revision;
            for (const [key, value] of merged) {
              this.notify(key, value);
            }
          }
        }
        throw retryErr;
      }
    }
  }

  private async conflictDocument(err: StoreWebError): Promise<SettingsDocument> {
    if (err.conflict) {
      return err.conflict;
    }
    try {
      return await this.transport.getSettings();
    } catch {
      throw err;
    }
  }

  private async bestEffortConflictDocument(
    err: StoreWebError,
  ): Promise<SettingsDocument | null> {
    if (err.conflict) {
      return err.conflict;
    }
    try {
      return await this.transport.getSettings();
    } catch {
      return null;
    }
  }

  private rejectSecretWrite(key: string): never {
    throw capabilityError(
      "unavailable",
      "store",
      "store.setSecretKey",
      "web",
      `Key "${key}" is a server-side secret with no Fase 1 write endpoint; ` +
        `reads behave as if the key does not exist`,
    );
  }

  private rejectUnknownWrite(key: string, method: string): never {
    throw capabilityError(
      "invalid_argument",
      "store",
      method === "set" ? "store.setUnknownKey" : "store.deleteUnknownKey",
      "web",
      `Key "${key}" is not known to the key schema; writes are rejected`,
    );
  }

  private rejectUndefinedValue(key: string): never {
    throw capabilityError(
      "invalid_argument",
      "store",
      "store.set",
      "web",
      `set() does not accept undefined for key "${key}"; use delete() to remove a key (F1-22 H3, AD-106)`,
    );
  }

  private queueSize(): number {
    return this.pending.size + this.pendingSecrets.size;
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.assertOpen();
    const cls = this.classify(key);
    if (cls === "R" || cls === "R_REJECT") {
      return undefined;
    }
    if (cls === "L") {
      if (!this.lCache.has(key)) {
        return undefined;
      }
      return cloneValue(this.lCache.get(key)) as T | undefined;
    }
    if (!this.sCache.has(key)) {
      return undefined;
    }
    return cloneValue(this.sCache.get(key)) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.assertOpen();
    const cls = this.classify(key);
    if (cls === "R" || cls === "R_REJECT") {
      this.rejectSecretWrite(key);
    }
    if (cls === "UNKNOWN") {
      this.rejectUnknownWrite(key, "set");
    }
    if (value === undefined) {
      // H3 (AD-106): reject before any flush, cache, queue, or
      // listener side effect, so the key stays unchanged.
      this.rejectUndefinedValue(key);
    }
    if (this.queueSize() >= MAX_QUEUE_ENTRIES && !this.pending.has(key)) {
      // Queue bound (V1-02 5.2.9): flush before accepting more.
      await this.enqueueFlush();
    }
    if (cls === "L") {
      this.lCache.set(key, cloneValue(value));
      this.localDirty = true;
      this.notify(key, value);
      this.markDirty();
      return;
    }
    if (key === "aiModelList") {
      const { metadata, secrets } = splitAiModelList(value);
      this.sCache.set(key, cloneValue(metadata));
      this.pending.set(key, { op: "set", value: cloneValue(metadata) });
      for (const [providerKey, patch] of secrets) {
        const existing = this.pendingSecrets.get(providerKey);
        this.pendingSecrets.set(providerKey, { ...existing, ...patch });
      }
      const listed = providerKeysOf(metadata);
      for (const providerKey of [...this.pendingSecrets.keys()]) {
        if (!listed.has(providerKey)) {
          // Removed providers lose their secrets through the server
          // cascade on PATCH; no PUT is sent for them.
          this.pendingSecrets.delete(providerKey);
        }
      }
      this.notify(key, metadata);
      this.markDirty();
      return;
    }
    this.sCache.set(key, cloneValue(value));
    this.pending.set(key, { op: "set", value: cloneValue(value) });
    this.notify(key, value);
    this.markDirty();
  }

  async has(key: string): Promise<boolean> {
    this.assertOpen();
    const cls = this.classify(key);
    if (cls === "R" || cls === "R_REJECT") {
      return false;
    }
    if (cls === "L") {
      return this.lCache.has(key);
    }
    return this.sCache.has(key);
  }

  async delete(key: string): Promise<boolean> {
    this.assertOpen();
    const cls = this.classify(key);
    if (cls === "R" || cls === "R_REJECT") {
      return false;
    }
    if (cls === "UNKNOWN") {
      this.rejectUnknownWrite(key, "delete");
    }
    if (cls === "L") {
      const existed = this.lCache.delete(key);
      if (existed) {
        this.localDirty = true;
        this.notify(key, undefined);
        this.markDirty();
      }
      return existed;
    }
    const existed = this.sCache.delete(key);
    if (key === "aiModelList") {
      this.pendingSecrets.clear();
    }
    this.pending.set(key, { op: "delete" });
    if (existed) {
      this.notify(key, undefined);
    }
    this.markDirty();
    return existed;
  }

  async clear(): Promise<void> {
    this.assertOpen();
    const keys = [...this.sCache.keys(), ...this.lCache.keys()];
    const sKeys = [...this.sCache.keys()];
    this.sCache.clear();
    this.lCache.clear();
    this.pending.clear();
    this.pendingSecrets.clear();
    for (const key of sKeys) {
      this.pending.set(key, { op: "delete" });
    }
    // Always queue aiModelList deletion so the server cascade
    // removes ai_provider secrets even when the cache never held
    // the key (V1-02 3.4, clear()).
    this.pending.set("aiModelList", { op: "delete" });
    this.localDirty = true;
    for (const key of keys) {
      this.notify(key, undefined);
    }
    this.markDirty();
  }

  async reset(): Promise<void> {
    await this.clear();
  }

  async keys(): Promise<string[]> {
    this.assertOpen();
    return [...this.sCache.keys(), ...this.lCache.keys()];
  }

  async values<T>(): Promise<T[]> {
    this.assertOpen();
    const combined = [...this.sCache.values(), ...this.lCache.values()];
    return combined.map((value) => cloneValue(value) as T);
  }

  async entries<T>(): Promise<Array<[string, T]>> {
    this.assertOpen();
    const combined: Array<[string, unknown]> = [
      ...this.sCache.entries(),
      ...this.lCache.entries(),
    ];
    return combined.map(
      ([key, value]) => [key, cloneValue(value) as T] as [string, T],
    );
  }

  async length(): Promise<number> {
    this.assertOpen();
    return this.sCache.size + this.lCache.size;
  }

  async reload(): Promise<void> {
    this.assertOpen();
    // reload() never fires listeners, including notifications from
    // the flush it runs first (conflict merges, rollbacks). The
    // flag is cleared even when the flush or refetch throws.
    this.notificationsSuppressed = true;
    try {
      await this.enqueueFlush();
      const doc = await this.transport.getSettings();
      const local = this.readLocalDocument();
      // Swap only after both reads succeed; the cache is untouched
      // when the refetch fails. No listeners fire (V1-02 3.4).
      this.populateServerCache(doc);
      this.populateLocalCache(local);
      this.emitPersistence();
    } finally {
      this.notificationsSuppressed = false;
    }
  }

  async save(): Promise<void> {
    this.assertOpen();
    await this.enqueueFlush();
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
    await this.enqueueFlush();
    this.closed = true;
    this.clearTimer();
    this.keyListeners.clear();
    this.changeListeners.clear();
    this.persistenceListeners.clear();
    if (this.channel !== null) {
      try {
        this.channel.close();
      } catch {
        // Ignore channel close errors.
      }
      this.channel = null;
    }
    this.onEvict();
  }

  pendingCount(): number {
    return (
      this.pending.size +
      this.pendingSecrets.size +
      (this.localDirty ? 1 : 0)
    );
  }

  lastRevision(): number | null {
    return this.revision;
  }

  lastFlushError(): Error | null {
    return this.lastError;
  }

  onPersistenceChange(
    cb: (state: PersistenceState) => void,
  ): UnlistenFn {
    this.persistenceListeners.add(cb);
    return () => {
      this.persistenceListeners.delete(cb);
    };
  }
}

function batchSettings(
  batch: Map<string, PendingEntry>,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [key, entry] of batch) {
    settings[key] = entry.op === "delete" ? null : cloneValue(entry.value);
  }
  return settings;
}

class WebStoreAdapter implements StoreAdapter {
  private readonly handles = new Map<string, WebStoreHandleImpl>();
  private readonly classify: StoreKeyClassifier;
  private readonly transport: Transport;
  private readonly storage: StoreWebStorage;
  private readonly broadcastCtor: StoreWebBroadcastChannelCtor | null;
  private readonly coalesceMs: number;
  private readonly maxWaitMs: number;
  private readonly createIdempotencyKeyFn: () => string;

  constructor(options: {
    classify: StoreKeyClassifier;
    transport: Transport;
    storage: StoreWebStorage;
    broadcastCtor: StoreWebBroadcastChannelCtor | null;
    coalesceMs: number;
    maxWaitMs: number;
    createIdempotencyKey: () => string;
  }) {
    this.classify = options.classify;
    this.transport = options.transport;
    this.storage = options.storage;
    this.broadcastCtor = options.broadcastCtor;
    this.coalesceMs = options.coalesceMs;
    this.maxWaitMs = options.maxWaitMs;
    this.createIdempotencyKeyFn = options.createIdempotencyKey;
  }

  async load(path: string, options?: StoreOptions): Promise<StoreHandle> {
    if (
      options?.serializeFnName !== undefined ||
      options?.deserializeFnName !== undefined
    ) {
      throw capabilityError(
        "unsupported",
        "store",
        "store.customSerializer",
        "web",
        "Custom serializer functions are registered on the Rust side and have no web equivalent",
      );
    }
    if (path !== WEB_SUPPORTED_STORE_PATH) {
      throw capabilityError(
        "unavailable",
        "store",
        "store.loadRemovedFile",
        "web",
        `Store file "${path}" is not available in the web fork; only "${WEB_SUPPORTED_STORE_PATH}" is supported`,
      );
    }
    const existing = this.handles.get(path);
    if (existing) {
      if (options?.createNew === true) {
        await existing.clear();
        await existing.save();
      }
      return existing;
    }
    const autoSave = options?.autoSave;
    const autoSaveEnabled = autoSave !== false;
    const coalesceMs =
      typeof autoSave === "number"
        ? Math.min(2000, Math.max(100, autoSave))
        : this.coalesceMs;
    const handle = new WebStoreHandleImpl(path, {
      classify: this.classify,
      transport: this.transport,
      storage: this.storage,
      broadcastCtor: this.broadcastCtor,
      coalesceMs,
      maxWaitMs: this.maxWaitMs,
      createIdempotencyKey: this.createIdempotencyKeyFn,
      autoSaveEnabled,
      onEvict: () => {
        this.handles.delete(path);
      },
    });
    await handle.initialize();
    if (options?.createNew === true) {
      await handle.clear();
      await handle.save();
    }
    this.handles.set(path, handle);
    return handle;
  }

  async getStore(path: string): Promise<StoreHandle | null> {
    return this.handles.get(path) ?? null;
  }

  async closeAll(): Promise<void> {
    const handles = [...this.handles.values()];
    let firstError: Error | null = null;
    for (const handle of handles) {
      try {
        await handle.close();
      } catch (err) {
        if (firstError === null) {
          firstError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }
    if (firstError !== null) {
      throw firstError;
    }
  }
}

/**
 * Creates a web StoreAdapter. See the module header for the injected
 * ports and the seams the integrator must wire (key-schema
 * classifier, shared API client/CSRF provider).
 */
export function createWebStoreAdapter(
  deps: WebStoreAdapterDeps = {},
): StoreAdapter {
  const fetchImpl: StoreWebFetch = deps.fetchImpl ?? defaultFetchImpl();
  const classify = deps.classifyKey ?? createDefaultStoreKeyClassifier();
  const memoryFallback = new MemoryStorage();
  const storage = resolveStorage(deps.storage, memoryFallback);
  const broadcastCtor = resolveBroadcastCtor(deps.broadcastChannelImpl);

  async function csrfHeader(
    mutating: boolean,
  ): Promise<Record<string, string>> {
    if (!mutating || !deps.getCsrfToken) {
      return {};
    }
    const token = await deps.getCsrfToken();
    return token ? { [CSRF_HEADER]: token } : {};
  }

  function errorFromEnvelope(
    status: number,
    parsed: unknown,
  ): StoreWebError {
    const envelope = isRecord(parsed) ? parsed : null;
    const body = envelope !== null && isRecord(envelope["error"])
      ? (envelope["error"] as Record<string, unknown>)
      : null;
    const code =
      (body !== null ? asString(body["code"]) : null) ??
      (status >= 500 ? "internal_error" : "unknown");
    const message =
      (body !== null ? asString(body["message"]) : null) ??
      `Settings request failed with status ${status}`;
    const requestId =
      body !== null ? (asString(body["requestId"]) ?? undefined) : undefined;
    const retryable = body !== null && body["retryable"] === true;
    let conflict: SettingsDocument | undefined;
    if (code === "revision_conflict" && body !== null) {
      const details = body["details"];
      if (isRecord(details)) {
        const revision = details["revision"];
        const settings = details["settings"];
        if (typeof revision === "number" && isRecord(settings)) {
          conflict = {
            revision,
            settings: cloneValue(settings),
          };
        }
      }
    }
    return new StoreWebError({
      code,
      status,
      message,
      retryable,
      requestId,
      conflict,
    });
  }

  async function requestData(
    method: string,
    url: string,
    body: unknown,
    opts: { mutating: boolean; idempotencyKey?: string },
  ): Promise<unknown> {
    let encoded: string | undefined;
    if (body !== undefined) {
      try {
        encoded = JSON.stringify(body);
      } catch (err) {
        throw new StoreWebError({
          code: "invalid_value",
          status: 0,
          message: `Settings request body is not JSON-serializable: ${messageOf(err)}`,
          retryable: false,
        });
      }
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (encoded !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (opts.idempotencyKey !== undefined) {
      headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;
    }
    Object.assign(headers, await csrfHeader(opts.mutating));
    let res: StoreWebFetchResponse;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: encoded,
        credentials: "same-origin",
      });
    } catch (err) {
      if (err instanceof StoreWebError) {
        throw err;
      }
      throw new StoreWebError({
        code: "network_error",
        status: 0,
        message: `Settings request failed: ${messageOf(err)}`,
        retryable: true,
      });
    }
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      throw new StoreWebError({
        code: "invalid_response",
        status: res.status,
        message: `Could not read settings response body: ${messageOf(err)}`,
        retryable: false,
      });
    }
    let parsed: unknown = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      throw errorFromEnvelope(res.status, parsed);
    }
    if (!isRecord(parsed) || parsed["ok"] !== true || !("data" in parsed)) {
      throw new StoreWebError({
        code: "invalid_response",
        status: res.status,
        message: "Settings response is not a success envelope",
        retryable: false,
      });
    }
    return parsed["data"];
  }

  const transport: Transport = {
    async getSettings(): Promise<SettingsDocument> {
      const data = await requestData("GET", SETTINGS_URL, undefined, {
        mutating: false,
      });
      if (
        !isRecord(data) ||
        typeof data["revision"] !== "number" ||
        !isRecord(data["settings"])
      ) {
        throw new StoreWebError({
          code: "invalid_response",
          status: 200,
          message: "GET /api/settings response has an unexpected shape",
          retryable: false,
        });
      }
      return {
        revision: data["revision"],
        settings: cloneValue(data["settings"]),
      };
    },

    async patchSettings(
      settings: Record<string, unknown>,
      baseRevision: number,
      idempotencyKey: string,
    ): Promise<PatchSettingsResult> {
      const data = await requestData(
        "PATCH",
        SETTINGS_URL,
        { settings, baseRevision },
        { mutating: true, idempotencyKey },
      );
      if (
        !isRecord(data) ||
        typeof data["revision"] !== "number" ||
        !Array.isArray(data["applied"]) ||
        !Array.isArray(data["rejected"])
      ) {
        throw new StoreWebError({
          code: "invalid_response",
          status: 200,
          message: "PATCH /api/settings response has an unexpected shape",
          retryable: false,
        });
      }
      const rejected: RejectedSettingKey[] = [];
      for (const entry of data["rejected"]) {
        if (
          isRecord(entry) &&
          typeof entry["key"] === "string" &&
          typeof entry["reason"] === "string"
        ) {
          rejected.push({ key: entry["key"], reason: entry["reason"] });
        } else {
          throw new StoreWebError({
            code: "invalid_response",
            status: 200,
            message: "PATCH /api/settings rejected entry has an unexpected shape",
            retryable: false,
          });
        }
      }
      return {
        revision: data["revision"],
        applied: data["applied"].filter(
          (key): key is string => typeof key === "string",
        ),
        rejected,
      };
    },

    async putAiProviders(
      providers: readonly AiProviderSecretUpdate[],
      idempotencyKey: string,
    ): Promise<void> {
      await requestData("PUT", SECRETS_PUT_URL, { providers }, {
        mutating: true,
        idempotencyKey,
      });
    },
  };

  return new WebStoreAdapter({
    classify,
    transport,
    storage,
    broadcastCtor,
    coalesceMs: deps.coalesceMs ?? DEFAULT_COALESCE_MS,
    maxWaitMs: deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    createIdempotencyKey: deps.createIdempotencyKey ?? defaultIdempotencyKey,
  });
}
