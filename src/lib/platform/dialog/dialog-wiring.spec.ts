// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Wiring spec for the DialogService-to-host connection (N-10, V3-11).
 *
 * Verifies that each dialog method reaches the host with the right
 * payload and returns the host resolution unchanged, that path-shaped
 * open/save reject per D-01 through the wired adapter, and that
 * throw-without-host behavior is preserved when no host is installed.
 * The host resolution seam (promise-based confirm/ask/message/prompt
 * in `web-dialog.tsx`) is what makes real answers possible; the fake
 * host below stands in for it. If the host ever loses its resolution
 * seam, this spec must be updated together with the wiring; do not
 * weaken the assertions silently.
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
  method: string;
  message: string;
  options: unknown;
}

interface FakeHostState {
  host: DialogHostPort;
  calls: HostCall[];
  /** Answer returned by confirm/ask. Mutable so tests can flip it. */
  answers: { confirm: boolean; ask: boolean; prompt: string | null };
}

function fakeHost(): FakeHostState {
  const calls: HostCall[] = [];
  const answers = { confirm: true, ask: false, prompt: "typed" as string | null };
  const host: DialogHostPort = {
    confirmDialog: async (message, options) => {
      calls.push({ method: "confirm", message, options });
      return answers.confirm;
    },
    askDialog: async (message, options) => {
      calls.push({ method: "ask", message, options });
      return answers.ask;
    },
    messageDialog: async (message, options) => {
      calls.push({ method: "message", message, options });
    },
    promptDialog: async (message, options) => {
      calls.push({ method: "prompt", message, options });
      return answers.prompt;
    },
  };
  return { host, calls, answers };
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
  test("message reaches the host and resolves when the host resolves", async () => {
    const { host, calls } = fakeHost();
    const service = createHostDialogService(host);
    await service.message("Hello", "Greeting");
    assert.deepEqual(calls, [
      { method: "message", message: "Hello", options: "Greeting" },
    ]);
  });

  test("message passes options through unchanged; the host owns defaults", async () => {
    const { host, calls } = fakeHost();
    const service = createHostDialogService(host);
    const options = { title: "Custom", kind: "warning" as const, okLabel: "Understood" };
    await service.message("Warning text", options);
    await service.message("Second");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options, options);
    assert.equal(calls[1].options, undefined);
  });

  test("confirm returns the host boolean and passes kind and labels through", async () => {
    const { host, calls, answers } = fakeHost();
    const service = createHostDialogService(host);
    const options = { title: "Confirm", kind: "warning" as const, okLabel: "Yes", cancelLabel: "No" };
    assert.equal(await service.confirm("Delete this file?", options), true);
    answers.confirm = false;
    assert.equal(await service.confirm("Delete this file?", options), false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options, options);
    assert.equal(calls[1].options, options);
  });

  test("ask returns the host boolean", async () => {
    const { host, calls, answers } = fakeHost();
    const service = createHostDialogService(host);
    assert.equal(await service.ask("Delete 3 entries?", "Delete"), false);
    answers.ask = true;
    assert.equal(await service.ask("Delete 3 entries?", "Delete"), true);
    assert.deepEqual(
      calls.map((call) => call.message),
      ["Delete 3 entries?", "Delete 3 entries?"],
    );
  });

  test("prompt returns the host text, or null on cancel", async () => {
    const { host, calls, answers } = fakeHost();
    const service = createHostDialogService(host);
    assert.equal(
      await service.prompt("Name?", { title: "Prompt", defaultValue: "x" }),
      "typed",
    );
    answers.prompt = null;
    assert.equal(await service.prompt("Name?", { title: "Prompt" }), null);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "prompt");
  });

  test("a host failure propagates unchanged instead of being wrapped", async () => {
    const failure = new Error("host exploded");
    const host: DialogHostPort = {
      confirmDialog: async () => {
        throw failure;
      },
      askDialog: async () => {
        throw failure;
      },
      messageDialog: async () => {
        throw failure;
      },
      promptDialog: async () => {
        throw failure;
      },
    };
    const service = createHostDialogService(host);
    await assert.rejects(() => service.message("Hi"), (error: unknown) => {
      assert.equal(error, failure);
      return true;
    });
    await assert.rejects(() => service.confirm("Sure?"), (error: unknown) => {
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
    // Each missing promise method is a TypeError, including a host
    // that only offers the legacy fire-and-forget openDialog.
    const partial = {
      openDialog: () => undefined,
    } as unknown as DialogHostPort;
    assert.throws(() => createHostDialogService(partial), TypeError);
    const { host } = fakeHost();
    const missingPrompt = { ...host, promptDialog: undefined };
    assert.throws(
      () =>
        createHostDialogService(missingPrompt as unknown as DialogHostPort),
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
    assert.equal(await adapter.confirm("Sure?"), true);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["message", "confirm"],
    );
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
    assert.equal(await adapter.confirm("Proceed?", "Title"), true);
    assert.deepEqual(calls, [
      { method: "message", message: "Wired", options: "Title" },
      { method: "confirm", message: "Proceed?", options: "Title" },
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
