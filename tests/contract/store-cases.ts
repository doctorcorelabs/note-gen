// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Store contract cases (parameterized over implementations).
//
// Case IDs come from two designs:
// - C-ST-01 to C-ST-06: fase1/desain-pengujian.md section 2.3.
// - CT-01, CT-02, CT-03, CT-09, CT-17, CT-22: the adapter-level subset of
//   fase1/desain-store-adapter.md section 8 that can run against a
//   StoreAdapter without a server, a browser, or localStorage. The
//   server/API cases (CT-10 to CT-15, CT-18, CT-21), the key-schema
//   cases (CT-05 to CT-08), CT-04 (createLazyStore helper, excluded
//   by V2-04), CT-16 (POC cleanup in the browser), CT-19 (desktop parity),
//   and CT-20 (CI gates) are recorded as deferred in
//   tests/contract/README.md.
//
// Cases assert observable behavior and error types/codes, never exact
// message text, except CT-X6 in the SQL suite which pins one upstream
// message. CT-02 asserts the H3 behavior for F1-22 (AD-106):
// set(key, undefined) throws a validation error
// (PlatformCapabilityError, invalid_argument) and leaves the key
// unchanged. See tests/contract/EXCEPTIONS.md entry E4.
// CT-02-nested asserts the step 3 rule for F1-22 (W4-F122Q): a nested
// undefined field inside an object value is dropped at the set()
// boundary and an undefined array element becomes null, matching the
// JSON wire form, while explicit null is preserved.
//
// C-ST-06 (persistence across restart) runs through factory.reopen(),
// which returns a new adapter over the same backing. Against the fake
// this proves in-process restart simulation only; cross-process
// persistence is a web/Tauri property (see EXCEPTIONS.md entry E1).
// The web column remaps arbitrary keys to catalogued S keys (E10),
// saves plus reloads for cross-handle visibility (E11), and asserts
// the real error taxonomy for closed handles and corrupt backing
// (E12). The fake column assertions are unchanged.

import { expect, it } from "vitest";
import { PlatformCapabilityError } from "../../src/lib/platform/errors";
import { isStoreWebError } from "../../src/lib/platform/store/store.web";
import { ContractError, isContractError } from "./contract-errors";
import type { ContractFactory } from "./contract-harness";
import type { StoreAdapter } from "./contract-types";

export interface StoreContractFactory extends ContractFactory<StoreAdapter> {
  reopen: (impl: StoreAdapter) => Promise<StoreAdapter>;
}

const REMOVED_STORE_FILES = [
  "sync_config.json",
  "sync_logs.json",
  "sync_timing_logs.json",
  "sync_remote_content_cache.json",
  "sync_file_proofs.json",
  "onedrive_data_sync_recovery.json",
  "desktop-screenshot.json",
  "workspace_path_moves.json",
  "self-hosted-sync-ui.json",
  "app-lock.json",
  "web-clipper.json",
  "local-mcp.json",
  "agent_debug_logs.json",
];

function requireReopen(
  factory: ContractFactory<StoreAdapter>,
): (impl: StoreAdapter) => Promise<StoreAdapter> {
  const reopen = (factory as StoreContractFactory).reopen;
  if (typeof reopen !== "function") {
    throw new Error(
      "Store contract factory must provide reopen() for restart cases",
    );
  }
  return reopen;
}

export function defineStoreCases(
  getImpl: () => StoreAdapter,
  factory: ContractFactory<StoreAdapter>,
): void {
  const isWeb = factory.name === "web";
  it("C-ST-01: round-trip get/set/save, visible to a reopened instance", async () => {
    const adapter = getImpl();
    const handle = await adapter.load("store.json");
    await handle.set("language", "en");
    await handle.set("editorLineHeight", 1.6);
    await handle.save();

    const reopened = await requireReopen(factory)(adapter);
    const handle2 = await reopened.load("store.json");
    await expect(handle2.get("language")).resolves.toBe("en");
    await expect(handle2.get("editorLineHeight")).resolves.toBe(1.6);
  });

  it("C-ST-02: a missing key reads as undefined, not a thrown error", async () => {
    const handle = await getImpl().load("store.json");
    await expect(handle.get("never-set-key")).resolves.toBeUndefined();
    await expect(handle.has("never-set-key")).resolves.toBe(false);
    await expect(handle.get("unknown-key-xyz")).resolves.toBeUndefined();
  });

  it("C-ST-03: concurrent writes from two sessions keep the store readable", async () => {
    const adapterA = getImpl();
    const adapterB = await requireReopen(factory)(adapterA);
    const handleA = await adapterA.load("store.json");
    const handleB = await adapterB.load("store.json");

    // E10: the web column writes catalogued S keys.
    const keyFromA = isWeb ? "language" : "key-from-a";
    const keyFromB = isWeb ? "editorLineHeight" : "key-from-b";
    const sharedKey = isWeb ? "primaryModel" : "shared-key";

    await Promise.all([
      handleA.set(keyFromA, "a-value"),
      handleB.set(keyFromB, "b-value"),
    ]);
    await Promise.all([
      handleA.set(sharedKey, "value-a"),
      handleB.set(sharedKey, "value-b"),
    ]);

    if (isWeb) {
      // E11: cross-handle visibility needs save plus reload.
      await handleA.save();
      await handleB.save();
      await handleA.reload();
    }

    const entries = await handleA.entries<unknown>();
    const doc = Object.fromEntries(entries);
    expect(doc[keyFromA]).toBe("a-value");
    expect(doc[keyFromB]).toBe("b-value");
    expect(["value-a", "value-b"]).toContain(doc[sharedKey]);
    expect(() => JSON.stringify(doc)).not.toThrow();
  });

  it("C-ST-05/CT-09: secret keys are invisible and unwritable through the store", async () => {
    const handle = await getImpl().load("store.json");
    const canary = "CANARY-SECRET-store-contract-001";

    for (const key of ["apiKey", "customSecretToken", "pin"]) {
      let thrown: unknown;
      try {
        await handle.set(key, canary);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PlatformCapabilityError);
      const capabilityError = thrown as PlatformCapabilityError;
      expect(capabilityError.capability.length).toBeGreaterThan(0);
      expect((capabilityError.reason ?? "").length).toBeGreaterThan(0);
      await expect(handle.get(key)).resolves.toBeUndefined();
      await expect(handle.has(key)).resolves.toBe(false);
      await expect(handle.delete(key)).resolves.toBe(false);
    }

    await handle.set("language", "en");
    const keys = await handle.keys();
    const entries = await handle.entries<unknown>();
    const values = await handle.values<unknown>();
    expect(keys).toEqual(["language"]);
    expect(entries).toEqual([["language", "en"]]);
    expect(values).toEqual(["en"]);
    await expect(handle.length()).resolves.toBe(1);
    expect(JSON.stringify(entries)).not.toContain(canary);
    expect(JSON.stringify(keys)).not.toContain(canary);
  });

  it("C-ST-06: settings survive a restart (reopened adapter over the same backing)", async () => {
    const adapter = getImpl();
    const handle = await adapter.load("store.json");
    await handle.set("primaryModel", "model-a");
    await handle.save();

    const reopened = await requireReopen(factory)(adapter);
    const handle2 = await reopened.load("store.json");
    await expect(handle2.get("primaryModel")).resolves.toBe("model-a");
  });

  it("CT-01: handle and adapter expose the full IStore surface", async () => {
    const adapter = getImpl();
    expect(typeof adapter.load).toBe("function");
    expect(typeof adapter.getStore).toBe("function");
    expect(typeof adapter.closeAll).toBe("function");

    const handle = await adapter.load("store.json");
    expect(handle.path).toBe("store.json");
    for (const method of [
      "get",
      "set",
      "has",
      "delete",
      "clear",
      "reset",
      "keys",
      "values",
      "entries",
      "length",
      "reload",
      "save",
      "onKeyChange",
      "onChange",
      "close",
    ] as const) {
      expect(typeof handle[method]).toBe("function");
    }
  });

  it("CT-02 (F1-22 H3, AD-106): set(key, undefined) throws and leaves the key unchanged", async () => {
    const handle = await getImpl().load("store.json");
    // E10: the web column writes catalogued S keys; UNKNOWN writes throw.
    const target = isWeb ? "darkMode" : "to-delete";
    const absent = isWeb ? "centeredContent" : "never-existed";
    await handle.set(target, "value");
    await expect(handle.has(target)).resolves.toBe(true);

    const assertValidationThrow = (thrown: unknown) => {
      expect(thrown).toBeInstanceOf(PlatformCapabilityError);
      const capabilityError = thrown as PlatformCapabilityError;
      expect(capabilityError.code).toBe("invalid_argument");
      expect(capabilityError.capability).toBe("store.set");
    };

    let thrownExisting: unknown;
    try {
      await handle.set(target, undefined);
    } catch (error) {
      thrownExisting = error;
    }
    assertValidationThrow(thrownExisting);
    await expect(handle.get(target)).resolves.toBe("value");
    await expect(handle.has(target)).resolves.toBe(true);
    await expect(handle.entries<unknown>()).resolves.toEqual([
      [target, "value"],
    ]);

    let thrownAbsent: unknown;
    try {
      await handle.set(absent, undefined);
    } catch (error) {
      thrownAbsent = error;
    }
    assertValidationThrow(thrownAbsent);
    await expect(handle.get(absent)).resolves.toBeUndefined();
    await expect(handle.has(absent)).resolves.toBe(false);
    await expect(handle.entries<unknown>()).resolves.toEqual([
      [target, "value"],
    ]);

    // The explicit delete() path still removes the key.
    await expect(handle.delete(target)).resolves.toBe(true);
    await expect(handle.has(target)).resolves.toBe(false);
  });

  it("CT-02-nested (F1-22 step 3, W4-F122Q): nested undefined fields follow the JSON wire form", async () => {
    const handle = await getImpl().load("store.json");
    // E10: the web column writes a catalogued S key.
    const key = isWeb ? "language" : "nested";
    const written: Record<string, unknown> = {
      dropped: undefined,
      kept: 1,
      nested: { dropped: undefined, kept: 2 },
      list: [undefined, 3, { dropped: undefined, kept: 4 }],
      explicitNull: null,
    };
    // set() resolves: only a top-level undefined throws (CT-02).
    await handle.set(key, written);
    // The caller's object is never mutated by normalization.
    expect("dropped" in written).toBe(true);
    expect(written.list).toEqual([undefined, 3, { dropped: undefined, kept: 4 }]);

    const read = (await handle.get<Record<string, unknown>>(key)) as Record<
      string,
      unknown
    >;
    // toEqual alone cannot pin this: it ignores undefined-valued
    // fields. Key presence is the assertion.
    expect("dropped" in read).toBe(false);
    expect(Object.keys(read).sort()).toEqual([
      "explicitNull",
      "kept",
      "list",
      "nested",
    ]);
    expect(read.kept).toBe(1);
    expect(read.nested).toEqual({ kept: 2 });
    expect("dropped" in (read.nested as Record<string, unknown>)).toBe(false);
    expect(read.list).toEqual([null, 3, { kept: 4 }]);
    expect("dropped" in (read.list as Array<unknown>)[2]!).toBe(false);
    expect("explicitNull" in read).toBe(true);
    expect(read.explicitNull).toBeNull();
    expect(JSON.stringify(read)).toBe(
      '{"kept":1,"nested":{"kept":2},"list":[null,3,{"kept":4}],"explicitNull":null}',
    );

    const entries = await handle.entries<Record<string, unknown>>();
    expect(entries).toHaveLength(1);
    expect(entries[0]![0]).toBe(key);
    expect("dropped" in entries[0]![1]).toBe(false);
  });

  it("CT-03a: basic semantics, keys/values/entries/length stay consistent", async () => {
    const handle = await getImpl().load("store.json");
    // E10: the web column writes catalogued S keys.
    const missing = isWeb ? "primaryModel" : "missing";
    const keyA = isWeb ? "language" : "a";
    const keyB = isWeb ? "editorLineHeight" : "b";
    await expect(handle.get(missing)).resolves.toBeUndefined();
    await expect(handle.has(missing)).resolves.toBe(false);
    await expect(handle.delete(missing)).resolves.toBe(false);

    await handle.set(keyB, 2);
    await handle.set(keyA, 1);
    await expect(handle.has(keyA)).resolves.toBe(true);
    await expect(handle.delete(keyA)).resolves.toBe(true);
    await expect(handle.delete(keyA)).resolves.toBe(false);
    await handle.set(keyA, 1);

    const keys = await handle.keys();
    const values = await handle.values<number>();
    const entries = await handle.entries<number>();
    expect([...keys].sort()).toEqual([keyA, keyB].sort());
    expect([...values].sort()).toEqual([1, 2]);
    expect(new Map(entries)).toEqual(
      new Map([
        [keyA, 1],
        [keyB, 2],
      ]),
    );
    await expect(handle.length()).resolves.toBe(2);
  });

  it("CT-03b: deep clone in both directions; set is visible without save()", async () => {
    const handle = await getImpl().load("store.json");
    // E10: the web column writes a catalogued S key.
    const key = isWeb ? "language" : "obj";
    const written = { nested: { count: 1 } };
    await handle.set(key, written);
    written.nested.count = 99;
    await expect(handle.get<{ nested: { count: number } }>(key)).resolves.toEqual({
      nested: { count: 1 },
    });

    const read = (await handle.get<{ nested: { count: number } }>(key)) as {
      nested: { count: number };
    };
    read.nested.count = 42;
    await expect(handle.get(key)).resolves.toEqual({
      nested: { count: 1 },
    });
  });

  it("CT-03c: listeners, reload without events, close, reset, getStore", async () => {
    const adapter = getImpl();
    await expect(adapter.getStore("store.json")).resolves.toBeNull();
    const handle = await adapter.load("store.json");
    await expect(adapter.getStore("store.json")).resolves.toBe(handle);

    // E10: the web column writes catalogued S keys.
    const watched = isWeb ? "language" : "watched";
    const other = isWeb ? "editorLineHeight" : "other";
    const afterReset = isWeb ? "primaryModel" : "after-reset";

    const seen: Array<[string, unknown]> = [];
    const unlisten = await handle.onChange((key, value) => {
      seen.push([key, value]);
    });
    await handle.set(watched, "v1");
    expect(seen).toEqual([[watched, "v1"]]);
    await handle.reload();
    expect(seen).toEqual([[watched, "v1"]]);
    unlisten();
    await handle.set(watched, "v2");
    expect(seen).toEqual([[watched, "v1"]]);

    await handle.set(other, 1);
    await handle.reset();
    await expect(handle.length()).resolves.toBe(0);
    await expect(handle.get(watched)).resolves.toBeUndefined();

    await handle.set(afterReset, true);
    await handle.close();
    if (isWeb) {
      // E12: the web adapter throws a plain Error on closed handles.
      await expect(handle.get(afterReset)).rejects.toThrowError(/is closed/);
      let thrown: unknown;
      try {
        await handle.get(afterReset);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(ContractError);
      expect(isStoreWebError(thrown)).toBe(false);
    } else {
      await expect(handle.get(afterReset)).rejects.toThrowError(ContractError);
      let thrown: unknown;
      try {
        await handle.get(afterReset);
      } catch (error) {
        thrown = error;
      }
      expect(isContractError(thrown, "NOT_FOUND")).toBe(true);
    }
  });

  it("CT-17: removed and unknown store files fail closed on load()", async () => {
    const adapter = getImpl();
    for (const name of [...REMOVED_STORE_FILES, "totally-unknown-store.json"]) {
      await expect(adapter.load(name)).rejects.toThrowError(
        PlatformCapabilityError,
      );
    }
  });

  it("CT-22: custom serializers are unavailable; createNew empties the document", async () => {
    const adapter = getImpl();
    await expect(
      adapter.load("store.json", { serializeFnName: "custom" }),
    ).rejects.toThrowError(PlatformCapabilityError);
    await expect(
      adapter.load("store.json", { deserializeFnName: "custom" }),
    ).rejects.toThrowError(PlatformCapabilityError);

    const handle = await adapter.load("store.json");
    // E10: the web column writes a catalogued S key.
    const keepMe = isWeb ? "language" : "keep-me";
    await handle.set(keepMe, "yes");
    const fresh = await adapter.load("store.json", {
      createNew: true,
      autoSave: 50,
    });
    await expect(fresh.get(keepMe)).resolves.toBeUndefined();
  });
}

export function defineCorruptStoreCases(
  getImpl: () => StoreAdapter,
  factory: ContractFactory<StoreAdapter>,
): void {
  it("C-ST-04: a corrupt store fails with a typed error, never a hang or undefined", async () => {
    let thrown: unknown;
    try {
      await getImpl().load("store.json");
    } catch (error) {
      thrown = error;
    }
    if (factory.name === "web-corrupt") {
      // E12: an unreachable backend surfaces as StoreWebError network_error.
      expect(isStoreWebError(thrown)).toBe(true);
      if (isStoreWebError(thrown)) {
        expect(thrown.code).toBe("network_error");
      }
    } else {
      expect(thrown).toBeInstanceOf(ContractError);
      expect(isContractError(thrown, "UNAVAILABLE")).toBe(true);
    }
  });
}
