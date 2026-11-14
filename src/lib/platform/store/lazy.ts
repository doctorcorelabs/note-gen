// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import type { UnlistenFn } from "../event/interface";
import type {
  StoreAdapter,
  StoreHandle,
  StoreOptions,
} from "./interface";

/**
 * Lazy handle that defers adapter.load() until the first method call
 * (V1-02 section 3.3, surface equivalent of the upstream LazyStore,
 * which has zero callers upstream). The same loaded handle is reused
 * for every later call. The path property is available synchronously
 * without triggering a load.
 */
export function createLazyStore(
  adapter: StoreAdapter,
  path: string,
  options?: StoreOptions,
): StoreHandle {
  let pending: Promise<StoreHandle> | null = null;
  const ensure = (): Promise<StoreHandle> => {
    if (pending === null) {
      pending = adapter.load(path, options);
    }
    return pending;
  };
  return {
    path,
    get: async <T>(key: string): Promise<T | undefined> =>
      (await ensure()).get<T>(key),
    set: async (key: string, value: unknown): Promise<void> =>
      (await ensure()).set(key, value),
    has: async (key: string): Promise<boolean> => (await ensure()).has(key),
    delete: async (key: string): Promise<boolean> =>
      (await ensure()).delete(key),
    clear: async (): Promise<void> => (await ensure()).clear(),
    reset: async (): Promise<void> => (await ensure()).reset(),
    keys: async (): Promise<string[]> => (await ensure()).keys(),
    values: async <T>(): Promise<T[]> => (await ensure()).values<T>(),
    entries: async <T>(): Promise<Array<[string, T]>> =>
      (await ensure()).entries<T>(),
    length: async (): Promise<number> => (await ensure()).length(),
    reload: async (): Promise<void> => (await ensure()).reload(),
    save: async (): Promise<void> => (await ensure()).save(),
    onKeyChange: async <T>(
      key: string,
      cb: (value: T | undefined) => void,
    ): Promise<UnlistenFn> => (await ensure()).onKeyChange<T>(key, cb),
    onChange: async <T>(
      cb: (key: string, value: T | undefined) => void,
    ): Promise<UnlistenFn> => (await ensure()).onChange<T>(cb),
    close: async (): Promise<void> => (await ensure()).close(),
  };
}
