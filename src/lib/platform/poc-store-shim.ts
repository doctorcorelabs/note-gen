// Copyright (C) 2026 doctorcorelabs
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.
//
// POC ONLY. This file is a minimal proof-of-concept replacement for
// `@tauri-apps/plugin-store` used only to prove that the app boots in a plain
// browser without Tauri (Fase 0 POC, W12). It is NOT the production
// StoreAdapter from design F1 and it MUST be removed and replaced by the
// backend-backed StoreAdapter in Fase 1 before any network-reachable deploy.
//
// WARNING: plaintext secrets. The real `store.json` holds API keys and tokens.
// This shim stores the whole document as plaintext JSON in localStorage,
// readable by any script on the same origin. Run the POC with test data only,
// never with real keys or tokens. Do not ship this file to production.
//
// Limitations (all intentional for the POC):
// - Backing storage is an in-memory Map plus localStorage, one JSON document
//   per store file name, under a key prefixed with `notegen-poc-store:`.
// - No backend, no encryption, no cross-tab sync (last write wins per doc).
// - No migration from a real desktop `store.json`; the POC starts empty.
// - `set(key, undefined)` deletes the key. This is a POC deviation from the
//   original plugin whose exact behavior for `undefined` was not verified
//   against the installed package; Fase 1 must confirm it.
// - `save()` throws on quota errors so a failed write is visible in the demo.
//   A corrupt or unreadable stored document falls back to an empty document
//   with one console warning, and never kills boot.
// - When localStorage is unavailable (SSR, blocked storage), the shim runs
//   in-memory only for that session and warns once.

export type StoreOptions = {
  autoSave?: boolean | number
  serializeFnName?: string
  deserializeFnName?: string
  createNew?: boolean
}

export type UnlistenFn = () => void

type ChangeListener = (key: string, value: unknown) => void
type KeyListener = (value: unknown) => void

const STORAGE_PREFIX = 'notegen-poc-store:'
const LOG_TAG = '[notegen-poc-store]'

const instances = new Map<string, Store>()
const loggedLoadPaths = new Set<string>()
let warnedStorageUnavailable = false
const warnedCorruptPaths = new Set<string>()

function storageKey(path: string): string {
  return `${STORAGE_PREFIX}${path}`
}

function readStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return null
    }
    return window.localStorage
  } catch {
    return null
  }
}

function warnStorageUnavailableOnce(): void {
  if (!warnedStorageUnavailable) {
    warnedStorageUnavailable = true
    console.warn(`${LOG_TAG} localStorage is unavailable; running in-memory only for this session`)
  }
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value
  }
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(value)
    }
  } catch {
    // Fall through to the JSON round-trip below.
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

function readDocumentFromStorage(path: string): Record<string, unknown> {
  const storage = readStorage()
  if (!storage) {
    warnStorageUnavailableOnce()
    return {}
  }
  let raw: string | null
  try {
    raw = storage.getItem(storageKey(path))
  } catch {
    warnStorageUnavailableOnce()
    return {}
  }
  if (raw === null || raw === '') {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Corrupt document: fall through to the empty-document fallback.
  }
  if (!warnedCorruptPaths.has(path)) {
    warnedCorruptPaths.add(path)
    console.warn(`${LOG_TAG} stored document for "${path}" is not a valid JSON object; starting empty`)
  }
  return {}
}

function writeDocumentToStorage(path: string, doc: Map<string, unknown>): void {
  const storage = readStorage()
  if (!storage) {
    warnStorageUnavailableOnce()
    return
  }
  const payload = JSON.stringify(Object.fromEntries(doc))
  // Let QuotaExceededError (and other write failures) propagate so a failed
  // save is visible instead of silently pretending to persist.
  storage.setItem(storageKey(path), payload)
}

export class Store {
  private readonly path: string
  private readonly options?: StoreOptions
  private readonly doc = new Map<string, unknown>()
  private readonly changeListeners = new Set<ChangeListener>()
  private readonly keyListeners = new Map<string, Set<KeyListener>>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  private constructor(path: string, options?: StoreOptions) {
    this.path = path
    this.options = options
    const initial = readDocumentFromStorage(path)
    for (const [key, value] of Object.entries(initial)) {
      this.doc.set(key, value)
    }
  }

  static async load(path: string, options?: StoreOptions): Promise<Store> {
    const cached = instances.get(path)
    if (cached) {
      return cached
    }
    const store = new Store(path, options)
    instances.set(path, store)
    if (!loggedLoadPaths.has(path)) {
      loggedLoadPaths.add(path)
      console.info(`${LOG_TAG} Store.load("${path}") served by the POC shim (in-memory + localStorage)`)
    }
    return store
  }

  static async get(path: string): Promise<Store | null> {
    return instances.get(path) ?? null
  }

  private scheduleAutoSave(): void {
    const autoSave = this.options?.autoSave
    if (autoSave === false) {
      return
    }
    const delay = typeof autoSave === 'number' ? autoSave : 100
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save().catch((error: unknown) => {
        console.error(`${LOG_TAG} auto-save failed for "${this.path}":`, error)
      })
    }, delay)
  }

  private notify(key: string, value: unknown): void {
    const cloned = cloneValue(value)
    for (const listener of [...this.changeListeners]) {
      try {
        listener(key, cloneValue(cloned))
      } catch (error) {
        console.error(`${LOG_TAG} onChange listener threw for key "${key}":`, error)
      }
    }
    const keySet = this.keyListeners.get(key)
    if (keySet) {
      for (const listener of [...keySet]) {
        try {
          listener(cloneValue(cloned))
        } catch (error) {
          console.error(`${LOG_TAG} onKeyChange listener threw for key "${key}":`, error)
        }
      }
    }
  }

  private notifyCleared(keys: string[]): void {
    for (const key of keys) {
      this.notify(key, undefined)
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.doc.get(key)
    if (value === undefined) {
      return undefined
    }
    return cloneValue(value) as T
  }

  async set(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      // POC deviation, documented in the file header: undefined deletes.
      const existed = this.doc.delete(key)
      if (existed) {
        this.notify(key, undefined)
      }
      this.scheduleAutoSave()
      return
    }
    this.doc.set(key, cloneValue(value))
    this.notify(key, value)
    this.scheduleAutoSave()
  }

  async has(key: string): Promise<boolean> {
    return this.doc.has(key)
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.doc.delete(key)
    if (existed) {
      this.notify(key, undefined)
      this.scheduleAutoSave()
    }
    return existed
  }

  async clear(): Promise<void> {
    const keys = [...this.doc.keys()]
    this.doc.clear()
    this.notifyCleared(keys)
    this.scheduleAutoSave()
  }

  async reset(): Promise<void> {
    // No default document exists in the POC, so reset behaves like clear,
    // matching the original plugin when no default value was set.
    await this.clear()
  }

  async keys(): Promise<string[]> {
    return [...this.doc.keys()]
  }

  async values<T>(): Promise<T[]> {
    return [...this.doc.values()].map(value => cloneValue(value) as T)
  }

  async entries<T>(): Promise<Array<[string, T]>> {
    return [...this.doc.entries()].map(
      ([key, value]) => [key, cloneValue(value) as T] as [string, T],
    )
  }

  async length(): Promise<number> {
    return this.doc.size
  }

  async reload(): Promise<void> {
    const fresh = readDocumentFromStorage(this.path)
    this.doc.clear()
    for (const [key, value] of Object.entries(fresh)) {
      this.doc.set(key, value)
    }
  }

  async save(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    writeDocumentToStorage(this.path, this.doc)
  }

  async onKeyChange<T>(key: string, cb: (value: T | undefined) => void): Promise<UnlistenFn> {
    let set = this.keyListeners.get(key)
    if (!set) {
      set = new Set()
      this.keyListeners.set(key, set)
    }
    const listener = cb as KeyListener
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) {
        this.keyListeners.delete(key)
      }
    }
  }

  async onChange<T>(cb: (key: string, value: T | undefined) => void): Promise<UnlistenFn> {
    const listener = cb as ChangeListener
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.changeListeners.clear()
    this.keyListeners.clear()
    if (instances.get(this.path) === this) {
      instances.delete(this.path)
    }
  }
}

export async function load(path: string, options?: StoreOptions): Promise<Store> {
  return Store.load(path, options)
}

export async function getStore(path: string): Promise<Store | null> {
  return Store.get(path)
}

// LazyStore is not used anywhere in src/ (0 usages at HEAD 4dcaa3f), but the
// original package exports it, so the shim exports a delegating version to
// avoid a surprise runtime failure if any path reaches it.
export class LazyStore {
  private readonly path: string
  private readonly options?: StoreOptions
  private inner: Promise<Store> | null = null

  constructor(path: string, options?: StoreOptions) {
    this.path = path
    this.options = options
  }

  private store(): Promise<Store> {
    if (!this.inner) {
      this.inner = Store.load(this.path, this.options)
    }
    return this.inner
  }

  async init(): Promise<void> {
    await this.store()
  }

  async set(key: string, value: unknown): Promise<void> {
    await (await this.store()).set(key, value)
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.store()).get<T>(key)
  }

  async has(key: string): Promise<boolean> {
    return (await this.store()).has(key)
  }

  async delete(key: string): Promise<boolean> {
    return (await this.store()).delete(key)
  }

  async clear(): Promise<void> {
    await (await this.store()).clear()
  }

  async reset(): Promise<void> {
    await (await this.store()).reset()
  }

  async keys(): Promise<string[]> {
    return (await this.store()).keys()
  }

  async values<T>(): Promise<T[]> {
    return (await this.store()).values<T>()
  }

  async entries<T>(): Promise<Array<[string, T]>> {
    return (await this.store()).entries<T>()
  }

  async length(): Promise<number> {
    return (await this.store()).length()
  }

  async reload(): Promise<void> {
    await (await this.store()).reload()
  }

  async save(): Promise<void> {
    await (await this.store()).save()
  }

  async onKeyChange<T>(key: string, cb: (value: T | undefined) => void): Promise<UnlistenFn> {
    return (await this.store()).onKeyChange<T>(key, cb)
  }

  async onChange<T>(cb: (key: string, value: T | undefined) => void): Promise<UnlistenFn> {
    return (await this.store()).onChange<T>(cb)
  }

  async close(): Promise<void> {
    await (await this.store()).close()
  }
}
