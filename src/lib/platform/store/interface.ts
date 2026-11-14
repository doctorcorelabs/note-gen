// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import type { UnlistenFn } from "../event/interface";

/**
 * StoreAdapter interface (migration wave G1, boot blocker).
 *
 * Replaces the upstream plugin-store surface: the Store class reached
 * through load, plus the instance methods used by the codebase.
 * Signatures mirror the installed upstream declarations (plugin-store 2.x)
 * and were checked against every import site in the reference tree at
 * 4dcaa3f, including dynamic imports.
 *
 * Notes from verification:
 * - load accepts the upstream options bag; the autoSave:false form is
 *   used at 6 call sites.
 * - reload and onKeyChange are used (1 call site each) and are included.
 * - onChange and reset have no call sites today but are kept: onChange is
 *   the change-notification seam the web implementation maps to watcher
 *   events, and reset is part of the store contract.
 * - length, close, the static get, the free load/getStore functions, and
 *   LazyStore have no call sites and are excluded.
 */
export interface StoreOptions {
  autoSave?: boolean | number;
  serializeFnName?: string;
  deserializeFnName?: string;
  createNew?: boolean;
}

export interface StoreHandle {
  set(key: string, value: unknown): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  reset(): Promise<void>;
  keys(): Promise<string[]>;
  values<T>(): Promise<T[]>;
  entries<T>(): Promise<Array<[key: string, value: T]>>;
  reload(): Promise<void>;
  save(): Promise<void>;
  onKeyChange<T>(
    key: string,
    cb: (value: T | undefined) => void,
  ): Promise<UnlistenFn>;
  onChange<T>(
    cb: (key: string, value: T | undefined) => void,
  ): Promise<UnlistenFn>;
}

export interface StoreAdapter {
  load(path: string, options?: StoreOptions): Promise<StoreHandle>;
}
