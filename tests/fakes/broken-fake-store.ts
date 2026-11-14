// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Deliberately BROKEN fake store, for the negative control only.
//
// This fake violates the store contract in two documented ways, so
// running the contract suite against it must FAIL:
//
// 1. Secret-key leak (violates C-ST-05/CT-09): set() over a secret
//    key succeeds and stores the value instead of throwing
//    PlatformCapabilityError, and get()/has()/keys()/entries()/
//    values()/length() expose it instead of behaving as if the key
//    did not exist.
// 2. save() discards the document (violates C-ST-01 and C-ST-06):
//    save() clears the backing map, so values written before save()
//    are gone when a reopened instance reads them back.
//
// Everything else delegates to the correct fake. This file must never
// be used as a factory in a normal suite run. It is selected only
// when CONTRACT_BROKEN_STORE=1 (see tests/contract/store.contract.ts
// and tests/contract/README.md). Do not "fix" this file: its defects
// are the point. If the contract changes, update the defect list
// here and the expected failures in the README together.

import {
  FakeStoreAdapter,
  FakeStoreHandle,
  isSecretStoreKey,
  type FakeStoreAdapterOptions,
} from "./fake-store";

function cloneBroken<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

class BrokenFakeStoreHandle extends FakeStoreHandle {
  private readonly shadow = new Map<string, unknown>();

  override async set(key: string, value: unknown): Promise<void> {
    if (isSecretStoreKey(key)) {
      // Defect 1: secret keys are stored instead of rejected.
      this.shadow.set(key, cloneBroken(value));
      return;
    }
    await super.set(key, value);
  }

  override async get<T>(key: string): Promise<T | undefined> {
    if (isSecretStoreKey(key)) {
      // Defect 1: secret keys read back instead of reading undefined.
      const value = this.shadow.get(key);
      return value === undefined ? undefined : cloneBroken(value as T);
    }
    return super.get<T>(key);
  }

  override async has(key: string): Promise<boolean> {
    if (isSecretStoreKey(key)) {
      return this.shadow.has(key);
    }
    return super.has(key);
  }

  override async delete(key: string): Promise<boolean> {
    if (isSecretStoreKey(key)) {
      return this.shadow.delete(key);
    }
    return super.delete(key);
  }

  override async keys(): Promise<string[]> {
    const visible = await super.keys();
    return [...visible, ...this.shadow.keys()];
  }

  override async entries<T>(): Promise<Array<[string, T]>> {
    const visible = await super.entries<T>();
    const leaked: Array<[string, T]> = [];
    for (const [key, value] of this.shadow) {
      leaked.push([key, cloneBroken(value as T)]);
    }
    return [...visible, ...leaked];
  }

  override async values<T>(): Promise<T[]> {
    const entries = await this.entries<T>();
    return entries.map(([, value]) => value);
  }

  override async length(): Promise<number> {
    return (await super.length()) + this.shadow.size;
  }

  override async clear(): Promise<void> {
    this.shadow.clear();
    await super.clear();
  }

  override async save(): Promise<void> {
    await super.save();
    // Defect 2: saving discards everything written so far.
    await super.clear();
  }
}

export class BrokenFakeStoreAdapter extends FakeStoreAdapter {
  protected override createHandle(
    path: string,
    backing: Map<string, unknown>,
  ): FakeStoreHandle {
    return new BrokenFakeStoreHandle(path, backing);
  }
}

export function createBrokenFakeStoreAdapter(
  options: FakeStoreAdapterOptions = {},
): BrokenFakeStoreAdapter {
  return new BrokenFakeStoreAdapter(options);
}
