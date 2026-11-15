// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Wiring spec for the DialogService-to-host connection (N-10, V3-11).
 *
 * Verifies that each dialog method reaches the host with the right
 * payload, that path-shaped open/save reject per D-01 through the
 * wired adapter, and that throw-without-host behavior is preserved
 * when no host is installed. The honest interim semantics of the
 * wiring (message resolves once presented; confirm/ask present and
 * then reject; prompt rejects without presenting) are pinned here
 * because they follow directly from the host gaps documented in
 * `dialog-wiring.ts` (GAP-1 to GAP-3). If the host gains a
 * resolution or input seam, this spec must be updated together with
 * the wiring; do not weaken the assertions silently.
 *
 * Run with node:test over an esbuild bundle (node:test cannot
 * resolve the extensionless relative imports the repo uses). From
 * the repo root, after `pnpm install`:
 *
 *   ./node_modules/.bin/esbuild src/lib/platform/dialog/dialog-wiring.spec.ts --bundle --platform=node --format=esm --outfile=/tmp/v3b-11d-dialog-wiring-test.mjs
 *   node --test /tmp/v3b-11d-dialog-wiring-test.mjs
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { PlatformCapabilityError } from "../errors";
import {
  __resetDefaultDialogServiceForTests,
  createWebDialogAdapter,
} from "./dialog.web";
import {
  createHostDialogService,
  createWiredWebDialogAdapter,
  installHostDialogService,
  type DialogHostPort,
} from "./dialog-wiring";
import type { WebDialogApi } from "../../../components/web-chrome/web-dialog";

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

interface HostCall {
  title: string;
  description: string | undefined;
}

function fakeHost(): { host: DialogHostPort; calls: HostCall[] } {
  const calls: HostCall[] = [];
  const host: DialogHostPort = {
    openDialog: (options: { title: string; description?: string }): void => {
      calls.push({ title: options.title, description: options.description });
    },
  };
  return { host, calls };
}

function expectCapabilityError(
  code: string,
  adapter: string,
  capability: string,
): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof PlatformCapabilityError &&
    error.code === code &&
    error.adapter === adapter &&
    error.capability === capability;
}

async function assertRejectsCapability(
  run: () => Promise<unknown>,
  code: string,
  capability: string,
): Promise<PlatformCapabilityError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(
    expectCapabilityError(code, "dialog", capability)(caught),
    `expected PlatformCapabilityError ${code}/dialog/${capability}, got ${String(caught)}`,
  );
  return caught as PlatformCapabilityError;
}

const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();

function setGlobal(key: string, value: unknown): void {
  if (!savedDescriptors.has(key)) {
    savedDescriptors.set(
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    );
  }
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

function restoreGlobals(): void {
  for (const [key, descriptor] of savedDescriptors) {
    if (descriptor === undefined) {
      delete (globalThis as Record<string, unknown>)[key];
    } else {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
  savedDescriptors.clear();
  __resetDefaultDialogServiceForTests();
}

beforeEach(() => {
  restoreGlobals();
});

afterEach(() => {
  restoreGlobals();
});

// ---------------------------------------------------------------------------
// Host port compatibility
// ---------------------------------------------------------------------------

describe("DialogHostPort compatibility", () => {
  test("WebDialogApi satisfies DialogHostPort without a runtime import", () => {
    // Compile-time proof: if WebDialogApi ever stops satisfying the
    // port, tsc fails on this assignment. The import is type-only,
    // so the esbuild bundle pulls in no React or UI code.
    const api = null as unknown as WebDialogApi;
    const port: DialogHostPort = api;
    assert.equal(port, api);
  });
});

// ---------------------------------------------------------------------------
// Host-backed DialogService
// ---------------------------------------------------------------------------

describe("host dialog service", () => {
  test("message reaches the host with the string title and the message", async () => {
    const { host, calls } = fakeHost();
    const service = createHostDialogService(host);
    await service.message("Hello", "Greeting");
    assert.deepEqual(calls, [{ title: "Greeting", description: "Hello" }]);
  });

  test("message uses the object title and falls back to the app name", async () => {
    const { host, calls } = fakeHost();
    const service = createHostDialogService(host);
    await service.message("First", { title: "Custom" });
    await service.message("Second");
    await service.message("Third", { title: "" });
    await service.message("Fourth", "");
    assert.deepEqual(
      calls.map((call) => call.title),
      ["Custom", "NoteGen", "NoteGen", "NoteGen"],
    );
    assert.deepEqual(
      calls.map((call) => call.description),
      ["First", "Second", "Third", "Fourth"],
    );
  });

  test("message accepts kind and okLabel without changing the host payload", async () => {
    const { host, calls } = fakeHost();
    const service = createHostDialogService(host);
    await service.message("Warning text", {
      title: "Alert",
      kind: "warning",
      okLabel: "Understood",
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]).sort(), ["description", "title"]);
    assert.equal(calls[0].title, "Alert");
    assert.equal(calls[0].description, "Warning text");
  });

  test("confirm presents the question and then rejects as unavailable", async () => {
    const { host, calls } = fakeHost();
    const service = createHostDialogService(host);
    const error = await assertRejectsCapability(
      () => service.confirm("Delete this file?", { title: "Confirm", kind: "warning" }),
      "unavailable",
      "confirm",
    );
    assert.deepEqual(calls, [
      { title: "Confirm", description: "Delete this file?" },
    ]);
    assert.ok(error.message.includes("resolution seam"));
  });

  test("ask presents the question and then rejects as unavailable", async () => {
    const { host, calls } = fakeHost();
    const service = createHostDialogService(host);
    const error = await assertRejectsCapability(
      () => service.ask("Delete 3 entries?", "Delete"),
      "unavailable",
      "ask",
    );
    assert.deepEqual(calls, [
      { title: "Delete", description: "Delete 3 entries?" },
    ]);
    assert.ok(error.message.includes("resolution seam"));
  });

  test("prompt rejects as unavailable and never presents", async () => {
    const { host, calls } = fakeHost();
    const service = createHostDialogService(host);
    await assertRejectsCapability(
      () => service.prompt("Name?", { title: "Prompt" }),
      "unavailable",
      "prompt",
    );
    await assertRejectsCapability(
      () => service.prompt("Name?", { title: "Prompt", defaultValue: "x" }),
      "unavailable",
      "prompt",
    );
    assert.equal(calls.length, 0);
  });

  test("a host failure propagates unchanged instead of being wrapped", async () => {
    const failure = new Error("host exploded");
    const host: DialogHostPort = {
      openDialog: (): void => {
        throw failure;
      },
    };
    const service = createHostDialogService(host);
    await assert.rejects(() => service.message("Hi"), (error: unknown) => {
      assert.equal(error, failure);
      return true;
    });
  });

  test("creating a service without a usable host throws a TypeError", () => {
    assert.throws(
      () => createHostDialogService(null as unknown as DialogHostPort),
      TypeError,
    );
    assert.throws(
      () => createHostDialogService({} as unknown as DialogHostPort),
      TypeError,
    );
    assert.throws(
      () =>
        createHostDialogService({
          openDialog: 1,
        } as unknown as DialogHostPort),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Module-default installation
// ---------------------------------------------------------------------------

describe("installHostDialogService", () => {
  test("an adapter without an explicit service delegates to the installed host", async () => {
    const { host, calls } = fakeHost();
    const installed = installHostDialogService(host);
    assert.ok(installed !== undefined);
    const adapter = createWebDialogAdapter();
    await adapter.message("Installed", "Title");
    assert.deepEqual(calls, [{ title: "Title", description: "Installed" }]);
  });

  test("installing again replaces the previous host", async () => {
    const first = fakeHost();
    const second = fakeHost();
    installHostDialogService(first.host);
    installHostDialogService(second.host);
    const adapter = createWebDialogAdapter();
    await adapter.message("Second host only", "T");
    assert.equal(first.calls.length, 0);
    assert.equal(second.calls.length, 1);
  });

  test("installing undefined restores throw-without-host behavior", async () => {
    const { host } = fakeHost();
    installHostDialogService(host);
    assert.equal(installHostDialogService(undefined), undefined);
    const adapter = createWebDialogAdapter();
    await assertRejectsCapability(
      () => adapter.confirm("Sure?"),
      "unavailable",
      "confirm",
    );
  });
});

// ---------------------------------------------------------------------------
// Wired adapter: delegation plus D-01 path-form rejection
// ---------------------------------------------------------------------------

describe("wired web dialog adapter", () => {
  test("message and confirm reach the host through the wired adapter", async () => {
    const { host, calls } = fakeHost();
    const adapter = createWiredWebDialogAdapter(host);
    await adapter.message("Wired", "Title");
    await assertRejectsCapability(
      () => adapter.confirm("Proceed?", "Title"),
      "unavailable",
      "confirm",
    );
    assert.deepEqual(calls, [
      { title: "Title", description: "Wired" },
      { title: "Title", description: "Proceed?" },
    ]);
  });

  test("path-shaped open rejects as unsupported and points at openFiles (D-01)", async () => {
    const { host } = fakeHost();
    const adapter = createWiredWebDialogAdapter(host);
    const error = await assertRejectsCapability(
      () => adapter.open({}),
      "unsupported",
      "open",
    );
    assert.ok(error.message.includes("openFiles"));
  });

  test("path-shaped save rejects as unsupported and points at saveBlob (D-01)", async () => {
    const { host } = fakeHost();
    const adapter = createWiredWebDialogAdapter(host);
    const error = await assertRejectsCapability(
      () => adapter.save({ defaultPath: "saved.md" }),
      "unsupported",
      "save",
    );
    assert.ok(error.message.includes("saveBlob"));
  });

  test("content-shaped openFiles still works through the wired adapter", async () => {
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    Object.defineProperty(file, "webkitRelativePath", { value: "a.txt" });
    const listeners = new Map<string, Array<() => void>>();
    const documentMock = {
      body: { appendChild: (): void => undefined },
      createElement: () => ({
        type: "",
        multiple: false,
        accept: "",
        webkitdirectory: false,
        style: {},
        files: [file],
        addEventListener: (type: string, listener: () => void): void => {
          const list = listeners.get(type) ?? [];
          list.push(listener);
          listeners.set(type, list);
        },
        click: (): void => {
          for (const listener of listeners.get("change") ?? []) {
            listener();
          }
        },
        remove: (): void => undefined,
      }),
    };
    setGlobal("document", documentMock);
    const { host } = fakeHost();
    const adapter = createWiredWebDialogAdapter(host);
    const result = await adapter.openFiles({ multiple: false });
    if (result === null || Array.isArray(result)) {
      assert.fail("expected a single picked file");
    }
    assert.equal(result.name, "a.txt");
    assert.equal(result.relativePath, "a.txt");
    assert.equal(result.file, file);
  });
});

// ---------------------------------------------------------------------------
// Throw-without-host behavior, preserved
// ---------------------------------------------------------------------------

describe("throw without host", () => {
  test("all four service methods reject when no host is installed", async () => {
    const adapter = createWebDialogAdapter();
    await assertRejectsCapability(
      () => adapter.confirm("Sure?"),
      "unavailable",
      "confirm",
    );
    await assertRejectsCapability(
      () => adapter.ask("Sure?"),
      "unavailable",
      "ask",
    );
    await assertRejectsCapability(
      () => adapter.message("Hi"),
      "unavailable",
      "message",
    );
    await assertRejectsCapability(
      () => adapter.prompt("Name?"),
      "unavailable",
      "prompt",
    );
  });
});
