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
//   cases (CT-05 to CT-08), CT-04 (createLazyStore helper, owned by
//   V2-04), CT-16 (POC cleanup in the browser), CT-19 (desktop parity),
//   and CT-20 (CI gates) are recorded as deferred in
//   tests/contract/README.md.
//
// Cases assert observable behavior and error types/codes, never exact
// message text, except CT-X6 in the SQL suite which pins one upstream
// message. CT-02 asserts the INTERIM behavior for F1-22
// (set(key, undefined) deletes the key, matching the POC shim) because
// the verdict against the Rust implementation is still unconfirmed; the
// case name says so, and the case must be re-parameterized when the
// verdict lands. See tests/contract/EXCEPTIONS.md entry E4.
//
// C-ST-06 (persistence across restart) runs through factory.reopen(),
// which returns a new adapter over the same backing. Against the fake
// this proves in-process restart simulation only; cross-process
// persistence is a web/Tauri property (see EXCEPTIONS.md entry E1).

import { expect, it } from "vitest";
import { PlatformCapabilityError } from "../../src/lib/platform/errors";
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

    await Promise.all([
      handleA.set("key-from-a", "a-value"),
      handleB.set("key-from-b", "b-value"),
    ]);
    await Promise.all([
      handleA.set("shared-key", "value-a"),
      handleB.set("shared-key", "value-b"),
    ]);

    const entries = await handleA.entries<unknown>();
    const doc = Object.fromEntries(entries);
    expect(doc["key-from-a"]).toBe("a-value");
    expect(doc["key-from-b"]).toBe("b-value");
    expect(["value-a", "value-b"]).toContain(doc["shared-key"]);
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

  it("CT-02-interim (F1-22 unconfirmed): set(key, undefined) deletes the key", async () => {
    const handle = await getImpl().load("store.json");
    await handle.set("to-delete", "value");
    await expect(handle.has("to-delete")).resolves.toBe(true);
    await handle.set("to-delete", undefined);
    await expect(handle.get("to-delete")).resolves.toBeUndefined();
    await expect(handle.has("to-delete")).resolves.toBe(false);
    await expect(handle.set("never-existed", undefined)).resolves.toBeUndefined();
    await expect(handle.get("never-existed")).resolves.toBeUndefined();
  });

  it("CT-03a: basic semantics, keys/values/entries/length stay consistent", async () => {
    const handle = await getImpl().load("store.json");
    await expect(handle.get("missing")).resolves.toBeUndefined();
    await expect(handle.has("missing")).resolves.toBe(false);
    await expect(handle.delete("missing")).resolves.toBe(false);

    await handle.set("b", 2);
    await handle.set("a", 1);
    await expect(handle.has("a")).resolves.toBe(true);
    await expect(handle.delete("a")).resolves.toBe(true);
    await expect(handle.delete("a")).resolves.toBe(false);
    await handle.set("a", 1);

    const keys = await handle.keys();
    const values = await handle.values<number>();
    const entries = await handle.entries<number>();
    expect([...keys].sort()).toEqual(["a", "b"]);
    expect([...values].sort()).toEqual([1, 2]);
    expect(new Map(entries)).toEqual(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    await expect(handle.length()).resolves.toBe(2);
  });

  it("CT-03b: deep clone in both directions; set is visible without save()", async () => {
    const handle = await getImpl().load("store.json");
    const written = { nested: { count: 1 } };
    await handle.set("obj", written);
    written.nested.count = 99;
    await expect(handle.get<{ nested: { count: number } }>("obj")).resolves.toEqual({
      nested: { count: 1 },
    });

    const read = (await handle.get<{ nested: { count: number } }>("obj")) as {
      nested: { count: number };
    };
    read.nested.count = 42;
    await expect(handle.get("obj")).resolves.toEqual({
      nested: { count: 1 },
    });
  });

  it("CT-03c: listeners, reload without events, close, reset, getStore", async () => {
    const adapter = getImpl();
    await expect(adapter.getStore("store.json")).resolves.toBeNull();
    const handle = await adapter.load("store.json");
    await expect(adapter.getStore("store.json")).resolves.toBe(handle);

    const seen: Array<[string, unknown]> = [];
    const unlisten = await handle.onChange((key, value) => {
      seen.push([key, value]);
    });
    await handle.set("watched", "v1");
    expect(seen).toEqual([["watched", "v1"]]);
    await handle.reload();
    expect(seen).toEqual([["watched", "v1"]]);
    unlisten();
    await handle.set("watched", "v2");
    expect(seen).toEqual([["watched", "v1"]]);

    await handle.set("other", 1);
    await handle.reset();
    await expect(handle.length()).resolves.toBe(0);
    await expect(handle.get("watched")).resolves.toBeUndefined();

    await handle.set("after-reset", true);
    await handle.close();
    await expect(handle.get("after-reset")).rejects.toThrowError(ContractError);
    let thrown: unknown;
    try {
      await handle.get("after-reset");
    } catch (error) {
      thrown = error;
    }
    expect(isContractError(thrown, "NOT_FOUND")).toBe(true);
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
    await handle.set("keep-me", "yes");
    const fresh = await adapter.load("store.json", {
      createNew: true,
      autoSave: 50,
    });
    await expect(fresh.get("keep-me")).resolves.toBeUndefined();
  });
}

export function defineCorruptStoreCases(
  getImpl: () => StoreAdapter,
): void {
  it("C-ST-04: a corrupt store fails with a typed error, never a hang or undefined", async () => {
    let thrown: unknown;
    try {
      await getImpl().load("store.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    expect(isContractError(thrown, "UNAVAILABLE")).toBe(true);
  });
}
