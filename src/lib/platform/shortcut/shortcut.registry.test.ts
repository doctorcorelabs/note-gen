// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the web shortcut registry (V2-13).
 *
 * No test runner is configured in package.json. Run with esbuild plus the
 * Node test runner (Node 24):
 *
 *   node_modules/.bin/esbuild src/lib/platform/shortcut/shortcut.registry.test.ts \
 *     --bundle --platform=node --format=cjs --outfile=/tmp/v2-13-shortcut-registry.test.cjs \
 *     && node --test /tmp/v2-13-shortcut-registry.test.cjs
 *
 * The tests use a fake document so they run without a browser. They cover
 * key matching, preventDefault behavior, the browser-reserved block list,
 * the 8 high-risk combos from audit V1-13, duplicates, global shortcut
 * rejection, enable/disable, and Mac versus non-Mac Mod matching.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PlatformCapabilityError } from "../errors";
import { createWebShortcutAdapter } from "./shortcut.web";

interface FakeKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

type KeyListener = (event: FakeKeyEvent) => void;

class FakeDocument {
  private readonly handlers = new Set<KeyListener>();

  addEventListener(_type: string, listener: KeyListener): void {
    this.handlers.add(listener);
  }

  removeEventListener(_type: string, listener: KeyListener): void {
    this.handlers.delete(listener);
  }

  dispatch(event: FakeKeyEvent): void {
    for (const listener of [...this.handlers]) listener(event);
  }

  listenerCount(): number {
    return this.handlers.size;
  }
}

function keyEvent(init: Partial<FakeKeyEvent> & { key: string }): FakeKeyEvent {
  const event: FakeKeyEvent = {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    isComposing: init.isComposing ?? false,
    prevented: false,
    stopped: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {
      event.stopped = true;
    },
  };
  return event;
}

describe("web shortcut registry", () => {
  test("a registered combo runs its handler and prevents the browser default", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    let calls = 0;
    const result = await adapter.register({
      id: "toggleBold",
      shortcut: "Mod+B",
      handler: () => {
        calls += 1;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.shortcut, "Mod+B");
    const event = keyEvent({ key: "b", ctrlKey: true });
    doc.dispatch(event);
    assert.equal(calls, 1);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    adapter.dispose();
  });

  test("an unregistered combo is never touched", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    await adapter.register({ id: "toggleBold", shortcut: "Mod+B", handler: () => undefined });
    const event = keyEvent({ key: "q", ctrlKey: true });
    doc.dispatch(event);
    assert.equal(event.prevented, false);
    adapter.dispose();
  });

  test("browser-reserved combos are always refused, even with the override flag", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    for (const shortcut of ["Mod+Shift+W", "Mod+Shift+T", "Mod+W", "Mod+T", "Mod+Shift+N"]) {
      const refused = await adapter.register({
        id: `blocked-${shortcut}`,
        shortcut,
        handler: () => undefined,
      });
      assert.equal(refused.ok, false, shortcut);
      assert.equal(refused.conflict?.kind, "browser-reserved");
      const overridden = await adapter.register(
        { id: `blocked-override-${shortcut}`, shortcut, handler: () => undefined },
        { allowBrowserConflict: true },
      );
      assert.equal(overridden.ok, false, `${shortcut} with override`);
      assert.equal(overridden.conflict?.kind, "browser-reserved");
    }
    assert.equal(adapter.list().length, 0);
    adapter.dispose();
  });

  test("DevTools combos from the high-risk list are blocked, not overridable", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    for (const shortcut of ["Shift+Mod+I", "Shift+Mod+J"]) {
      const result = await adapter.register(
        { id: `devtools-${shortcut}`, shortcut, handler: () => undefined },
        { allowBrowserConflict: true },
      );
      assert.equal(result.ok, false, shortcut);
      assert.equal(result.conflict?.kind, "browser-reserved");
    }
    adapter.dispose();
  });

  test("high-risk combos are refused by default and allowed with an explicit override", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    const refused = await adapter.register({
      id: "openLinkInput",
      shortcut: "Mod+K",
      handler: () => undefined,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.conflict?.kind, "browser-high-risk");
    assert.equal(refused.conflict?.blocking, true);

    let calls = 0;
    const allowed = await adapter.register(
      {
        id: "openLinkInput",
        shortcut: "Mod+K",
        handler: () => {
          calls += 1;
        },
      },
      { allowBrowserConflict: true },
    );
    assert.equal(allowed.ok, true);
    assert.equal(allowed.conflict?.kind, "browser-high-risk");
    assert.equal(allowed.conflict?.blocking, false);
    doc.dispatch(keyEvent({ key: "k", ctrlKey: true }));
    assert.equal(calls, 1);
    adapter.dispose();
  });

  test("all 8 high-risk combos are detected by checkConflict", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    const highRisk: [string, string][] = [
      ["Shift+Mod+O", "browser-high-risk"],
      ["Mod+U", "browser-high-risk"],
      ["Mod+E", "browser-high-risk"],
      ["Mod+K", "browser-high-risk"],
      ["Shift+Mod+B", "browser-high-risk"],
      ["Mod+J", "browser-high-risk"],
      ["Shift+Mod+J", "browser-reserved"],
      ["Shift+Mod+I", "browser-reserved"],
    ];
    for (const [shortcut, kind] of highRisk) {
      assert.equal(adapter.checkConflict(shortcut)?.kind, kind, shortcut);
    }
    assert.equal(adapter.checkConflict("Mod+B"), null);
    assert.equal(adapter.checkConflict("CommandOrControl+Shift+O")?.kind, "browser-high-risk");
    adapter.dispose();
  });

  test("duplicate combos are refused unless replaced", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    let firstCalls = 0;
    let secondCalls = 0;
    await adapter.register({
      id: "first",
      shortcut: "Mod+B",
      handler: () => {
        firstCalls += 1;
      },
    });
    const duplicate = await adapter.register({
      id: "second",
      shortcut: "Mod+B",
      handler: () => {
        secondCalls += 1;
      },
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.conflict?.kind, "duplicate");
    const replaced = await adapter.register(
      {
        id: "second",
        shortcut: "Mod+B",
        handler: () => {
          secondCalls += 1;
        },
      },
      { replaceExisting: true },
    );
    assert.equal(replaced.ok, true);
    doc.dispatch(keyEvent({ key: "b", ctrlKey: true }));
    assert.equal(firstCalls, 0);
    assert.equal(secondCalls, 1);
    assert.equal(adapter.list().length, 1);
    adapter.dispose();
  });

  test("re-registering the same id replaces its handler", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    let calls = 0;
    await adapter.register({ id: "same", shortcut: "Mod+B", handler: () => undefined });
    await adapter.register({
      id: "same",
      shortcut: "Mod+I",
      handler: () => {
        calls += 1;
      },
    });
    assert.equal(await adapter.isRegistered("Mod+B"), false);
    assert.equal(await adapter.isRegistered("Mod+I"), true);
    doc.dispatch(keyEvent({ key: "i", ctrlKey: true }));
    assert.equal(calls, 1);
    adapter.dispose();
  });

  test("unregister and unregisterShortcut remove bindings", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    await adapter.register({ id: "a", shortcut: "Mod+B", handler: () => undefined });
    await adapter.register({ id: "b", shortcut: "Mod+I", handler: () => undefined });
    assert.equal(await adapter.unregister("missing"), false);
    assert.equal(await adapter.unregister("a"), true);
    assert.equal(await adapter.isRegistered("Mod+B"), false);
    assert.equal(await adapter.unregisterShortcut("Mod+I"), true);
    assert.equal(adapter.list().length, 0);
    adapter.dispose();
  });

  test("invalid combos are refused with a parse error, not a throw", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    const result = await adapter.register({
      id: "bad",
      shortcut: "Mod+",
      handler: () => undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.conflict?.kind, "invalid");
    assert.equal(adapter.checkConflict("")?.kind, "invalid");
    adapter.dispose();
  });

  test("registerGlobal throws PlatformCapabilityError and globals are unsupported", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    assert.equal(adapter.supportsGlobalShortcuts(), false);
    await assert.rejects(
      () =>
        adapter.registerGlobal({
          id: "openWindow",
          shortcut: "CommandOrControl+Shift+W",
          handler: () => undefined,
        }),
      PlatformCapabilityError,
    );
    adapter.dispose();
  });

  test("disabled adapters ignore keys without preventing defaults", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    let calls = 0;
    await adapter.register({
      id: "toggleBold",
      shortcut: "Mod+B",
      handler: () => {
        calls += 1;
      },
    });
    adapter.setEnabled(false);
    assert.equal(adapter.isEnabled(), false);
    const event = keyEvent({ key: "b", ctrlKey: true });
    doc.dispatch(event);
    assert.equal(calls, 0);
    assert.equal(event.prevented, false);
    adapter.setEnabled(true);
    doc.dispatch(keyEvent({ key: "b", ctrlKey: true }));
    assert.equal(calls, 1);
    adapter.dispose();
  });

  test("Mod means Cmd on macOS and Ctrl elsewhere", async () => {
    const macDoc = new FakeDocument();
    const mac = createWebShortcutAdapter({ documentLike: macDoc, isMac: true });
    let macCalls = 0;
    await mac.register({
      id: "toggleBold",
      shortcut: "Mod+B",
      handler: () => {
        macCalls += 1;
      },
    });
    macDoc.dispatch(keyEvent({ key: "b", ctrlKey: true }));
    assert.equal(macCalls, 0);
    macDoc.dispatch(keyEvent({ key: "b", metaKey: true }));
    assert.equal(macCalls, 1);
    mac.dispose();

    const winDoc = new FakeDocument();
    const win = createWebShortcutAdapter({ documentLike: winDoc, isMac: false });
    let winCalls = 0;
    await win.register({
      id: "toggleBold",
      shortcut: "Mod+B",
      handler: () => {
        winCalls += 1;
      },
    });
    winDoc.dispatch(keyEvent({ key: "b", metaKey: true }));
    assert.equal(winCalls, 0);
    winDoc.dispatch(keyEvent({ key: "b", ctrlKey: true }));
    assert.equal(winCalls, 1);
    win.dispose();
  });

  test("dispose removes the key listener and clears bindings", async () => {
    const doc = new FakeDocument();
    const adapter = createWebShortcutAdapter({ documentLike: doc, isMac: false });
    await adapter.register({ id: "a", shortcut: "Mod+B", handler: () => undefined });
    assert.equal(doc.listenerCount(), 1);
    adapter.dispose();
    assert.equal(doc.listenerCount(), 0);
    assert.equal(adapter.list().length, 0);
  });
});
