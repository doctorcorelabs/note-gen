// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the web event bus (V2-13).
 *
 * No test runner is configured in package.json. Run with esbuild plus the
 * Node test runner (Node 24):
 *
 *   node_modules/.bin/esbuild src/lib/platform/event/event.bus.test.ts \
 *     --bundle --platform=node --format=cjs --outfile=/tmp/v2-13-event-bus.test.cjs \
 *     && node --test /tmp/v2-13-event-bus.test.cjs
 *
 * The tests use fake BroadcastChannel, window, and document objects so
 * they run without a browser. They cover local delivery, unlisten, once,
 * cross-tab delivery without echo, emitTo targeting, the tauri://focus and
 * tauri://created mappings, bridge-event rejection, and dispose.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PlatformCapabilityError } from "../errors";
import { createWebEventAdapter } from "./event.web";

type ChannelListener = (event: { data: unknown }) => void;

class FakeBroadcastChannel {
  static hub = new Set<FakeBroadcastChannel>();

  onmessage: ChannelListener | null = null;
  readonly channelName: string;

  constructor(channelName: string) {
    this.channelName = channelName;
    FakeBroadcastChannel.hub.add(this);
  }

  postMessage(data: unknown): void {
    const copy = JSON.parse(JSON.stringify(data)) as unknown;
    for (const other of [...FakeBroadcastChannel.hub]) {
      if (other === this) continue;
      other.onmessage?.({ data: copy });
    }
  }

  close(): void {
    FakeBroadcastChannel.hub.delete(this);
  }
}

function resetHub(): void {
  FakeBroadcastChannel.hub.clear();
}

class FakeFocusSource {
  private readonly handlers = new Map<string, Set<() => void>>();
  visibilityState = "visible";

  addEventListener(type: string, listener: () => void): void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.handlers.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.handlers.get(type) ?? [])]) listener();
  }

  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("web event bus", () => {
  test("emit delivers payload to a listener with event name and id", async () => {
    resetHub();
    const adapter = createWebEventAdapter({
      createBroadcastChannel: () => null,
      windowLike: null,
      documentLike: null,
    });
    const seen: { event: string; payload: unknown; id: number }[] = [];
    await adapter.listen("article-saved", (event) => {
      seen.push({ event: event.event, payload: event.payload, id: event.id });
    });
    await adapter.emit("article-saved", { path: "a.md" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.event, "article-saved");
    assert.deepEqual(seen[0]?.payload, { path: "a.md" });
    assert.equal(typeof seen[0]?.id, "number");
    adapter.dispose();
  });

  test("unlisten stops delivery and listenerCount drops", async () => {
    resetHub();
    const adapter = createWebEventAdapter({
      createBroadcastChannel: () => null,
      windowLike: null,
      documentLike: null,
    });
    let calls = 0;
    const unlisten = await adapter.listen("ping", () => {
      calls += 1;
    });
    assert.equal(adapter.listenerCount("ping"), 1);
    assert.equal(adapter.listenerCount(), 1);
    await adapter.emit("ping");
    unlisten();
    assert.equal(adapter.listenerCount("ping"), 0);
    await adapter.emit("ping");
    assert.equal(calls, 1);
    adapter.dispose();
  });

  test("once fires exactly once", async () => {
    resetHub();
    const adapter = createWebEventAdapter({
      createBroadcastChannel: () => null,
      windowLike: null,
      documentLike: null,
    });
    let calls = 0;
    await adapter.once("ping", () => {
      calls += 1;
    });
    await adapter.emit("ping");
    await adapter.emit("ping");
    assert.equal(calls, 1);
    assert.equal(adapter.listenerCount("ping"), 0);
    adapter.dispose();
  });

  test("cross-tab emit reaches the other tab once and does not echo to the sender", async () => {
    resetHub();
    const sender = createWebEventAdapter({
      windowLabel: "main",
      createBroadcastChannel: (name) => new FakeBroadcastChannel(name),
      windowLike: null,
      documentLike: null,
    });
    const receiver = createWebEventAdapter({
      windowLabel: "editor-1",
      createBroadcastChannel: (name) => new FakeBroadcastChannel(name),
      windowLike: null,
      documentLike: null,
    });
    let senderCalls = 0;
    let receiverCalls = 0;
    await sender.listen("article-saved", () => {
      senderCalls += 1;
    });
    await receiver.listen("article-saved", () => {
      receiverCalls += 1;
    });
    await sender.emit("article-saved", { path: "a.md" });
    assert.equal(senderCalls, 1);
    assert.equal(receiverCalls, 1);
    sender.dispose();
    receiver.dispose();
  });

  test("emitTo with a label delivers only to the matching tab", async () => {
    resetHub();
    const main = createWebEventAdapter({
      windowLabel: "main",
      createBroadcastChannel: (name) => new FakeBroadcastChannel(name),
      windowLike: null,
      documentLike: null,
    });
    const editor = createWebEventAdapter({
      windowLabel: "editor-1",
      createBroadcastChannel: (name) => new FakeBroadcastChannel(name),
      windowLike: null,
      documentLike: null,
    });
    let mainCalls = 0;
    let editorCalls = 0;
    await main.listen("ping", () => {
      mainCalls += 1;
    });
    await editor.listen("ping", () => {
      editorCalls += 1;
    });
    await main.emitTo("editor-1", "ping");
    assert.equal(mainCalls, 0);
    assert.equal(editorCalls, 1);
    await main.emitTo({ kind: "window", label: "main" }, "ping");
    assert.equal(mainCalls, 1);
    assert.equal(editorCalls, 1);
    await main.emitTo({ kind: "any" }, "ping");
    assert.equal(mainCalls, 2);
    assert.equal(editorCalls, 2);
    main.dispose();
    editor.dispose();
  });

  test("tauri://focus and tauri://blur come from DOM focus and visibility", async () => {
    resetHub();
    const fakeWindow = new FakeFocusSource();
    const fakeDocument = new FakeFocusSource();
    const adapter = createWebEventAdapter({
      createBroadcastChannel: () => null,
      windowLike: fakeWindow,
      documentLike: fakeDocument,
    });
    let focusCalls = 0;
    let blurCalls = 0;
    const unlistenFocus = await adapter.listen("tauri://focus", () => {
      focusCalls += 1;
    });
    const unlistenBlur = await adapter.listen("tauri://blur", () => {
      blurCalls += 1;
    });
    assert.equal(fakeWindow.listenerCount("focus"), 1);
    fakeWindow.dispatch("focus");
    assert.equal(focusCalls, 1);
    fakeWindow.dispatch("blur");
    assert.equal(blurCalls, 1);
    fakeDocument.visibilityState = "hidden";
    fakeDocument.dispatch("visibilitychange");
    assert.equal(blurCalls, 2);
    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatch("visibilitychange");
    assert.equal(focusCalls, 2);
    unlistenFocus();
    unlistenBlur();
    assert.equal(fakeWindow.listenerCount("focus"), 0);
    adapter.dispose();
  });

  test("tauri://created fires once right after listen and once", async () => {
    resetHub();
    const adapter = createWebEventAdapter({
      createBroadcastChannel: () => null,
      windowLike: null,
      documentLike: null,
    });
    let listenCalls = 0;
    let onceCalls = 0;
    await adapter.listen("tauri://created", () => {
      listenCalls += 1;
    });
    await adapter.once("tauri://created", () => {
      onceCalls += 1;
    });
    await delay(10);
    assert.equal(listenCalls, 1);
    assert.equal(onceCalls, 1);
    assert.equal(adapter.listenerCount("tauri://created"), 1);
    adapter.dispose();
  });

  test("emitting a bridge event throws PlatformCapabilityError", async () => {
    resetHub();
    const adapter = createWebEventAdapter({
      createBroadcastChannel: () => null,
      windowLike: null,
      documentLike: null,
    });
    await assert.rejects(
      () => adapter.emit("web-clipper://request", {}),
      PlatformCapabilityError,
    );
    await assert.rejects(
      () => adapter.emitTo("main", "local-mcp://request", {}),
      PlatformCapabilityError,
    );
    adapter.dispose();
  });

  test("a failing listener does not break other listeners or the emitter", async () => {
    resetHub();
    const errors: unknown[] = [];
    const adapter = createWebEventAdapter({
      createBroadcastChannel: () => null,
      windowLike: null,
      documentLike: null,
      onHandlerError: (error) => {
        errors.push(error);
      },
    });
    let goodCalls = 0;
    await adapter.listen("ping", () => {
      throw new Error("listener boom");
    });
    await adapter.listen("ping", () => {
      goodCalls += 1;
    });
    await adapter.emit("ping");
    assert.equal(goodCalls, 1);
    assert.equal(errors.length, 1);
    adapter.dispose();
  });

  test("dispose clears listeners and stops cross-tab delivery", async () => {
    resetHub();
    const sender = createWebEventAdapter({
      windowLabel: "main",
      createBroadcastChannel: (name) => new FakeBroadcastChannel(name),
      windowLike: null,
      documentLike: null,
    });
    const receiver = createWebEventAdapter({
      windowLabel: "editor-1",
      createBroadcastChannel: (name) => new FakeBroadcastChannel(name),
      windowLike: null,
      documentLike: null,
    });
    let calls = 0;
    await receiver.listen("ping", () => {
      calls += 1;
    });
    receiver.dispose();
    assert.equal(receiver.listenerCount(), 0);
    await sender.emit("ping");
    assert.equal(calls, 0);
    sender.dispose();
  });
});
