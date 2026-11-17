// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for src/lib/web/watcher-client.ts (V3-09).
//
// Runner: Vitest, unit project (vitest run --project unit). Every
// case uses injected fakes: a fake watch function, fake window and
// document event sources, and a fake clock. No test opens a
// WebSocket, sends HTTP, or touches the DOM, navigation, or storage.
// Sequence-level resync, debounce inside the adapter, and the
// polling snapshot loop are owned and tested by FsAdapter.watch()
// (src/lib/platform/fs/fs.web.contract.test.ts) and are not
// duplicated here. These cases cover only the V3-09 layer: ordered
// forwarding, tree resync triggers and their coalescing, honest
// fallback status, single-subscription discipline, and disposal.

import { beforeEach, describe, expect, it } from "vitest";

import type { WatchEvent } from "../platform";

import {
  createWatcherClient,
  getWatcherStatus,
  resetWatcherStatusStore,
  subscribeWatcherStatus,
  watcherStatusMessage,
  WATCHER_CLIENT_DELAY_MS,
  WATCHER_RESYNC_COALESCE_MS,
  type WatcherClientStatus,
  type WatcherResyncReason,
  type WatcherWatchFn,
} from "./watcher-client";

function createdEvent(path: string): WatchEvent {
  return { type: { create: { kind: "file" } }, paths: [path], attrs: null };
}

function changedEvent(path: string): WatchEvent {
  return {
    type: { modify: { kind: "data", mode: "content" } },
    paths: [path],
    attrs: null,
  };
}

function rescanEvent(path: string): WatchEvent {
  return { type: "any", paths: [path], attrs: null };
}

class FakeEventSource {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener();
    }
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeDocument extends FakeEventSource {
  visibilityState = "visible";
}

interface FakeWatch {
  calls: Array<{ root: string; delayMs: number | undefined; recursive: boolean | undefined }>;
  unwatchCalls: number;
  rejectWith: Error | null;
  watch: WatcherWatchFn;
  emit: (event: WatchEvent) => void;
  callback: ((event: WatchEvent) => void) | null;
}

function createFakeWatch(): FakeWatch {
  const fake: FakeWatch = {
    calls: [],
    unwatchCalls: 0,
    rejectWith: null,
    callback: null,
    watch: async (root, cb, options) => {
      fake.calls.push({
        root,
        delayMs: options?.delayMs,
        recursive: options?.recursive,
      });
      if (fake.rejectWith !== null) {
        throw fake.rejectWith;
      }
      fake.callback = cb;
      return () => {
        fake.unwatchCalls += 1;
      };
    },
    emit: (event) => {
      fake.callback?.(event);
    },
  };
  return fake;
}

function statusWith(state: WatcherClientStatus["state"]): WatcherClientStatus {
  return {
    state,
    transport: "unknown",
    mode: "web",
    lastEventAt: null,
    detail: null,
  };
}

beforeEach(() => {
  resetWatcherStatusStore();
});

describe("watcher client subscription", () => {
  it("starts one subscription with recursive watch and the default 300 ms delay", async () => {
    const fake = createFakeWatch();
    const client = createWatcherClient({
      root: "/appdata/article",
      watch: fake.watch,
      onEvent: () => undefined,
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      shareStatus: false,
    });
    expect(client.status.state).toBe("starting");
    await client.start();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.root).toBe("/appdata/article");
    expect(fake.calls[0]?.recursive).toBe(true);
    expect(fake.calls[0]?.delayMs).toBe(300);
    expect(client.status.state).toBe("active");
    expect(client.status.transport).toBe("unknown");
    client.dispose();
  });

  it("start is idempotent and opens exactly one subscription", async () => {
    const fake = createFakeWatch();
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      shareStatus: false,
    });
    await Promise.all([client.start(), client.start(), client.start()]);
    expect(fake.calls).toHaveLength(1);
    client.dispose();
  });

  it("forwards a delayMs override to the watch function", async () => {
    const fake = createFakeWatch();
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      delayMs: 120,
      onEvent: () => undefined,
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      shareStatus: false,
    });
    await client.start();
    expect(fake.calls[0]?.delayMs).toBe(120);
    client.dispose();
  });

  it("forwards events in arrival order and records the last event time", async () => {
    const fake = createFakeWatch();
    const seen: string[] = [];
    let nowValue = 1000;
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: (event) => {
        seen.push(event.paths[0] ?? "");
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      now: () => nowValue,
      shareStatus: false,
    });
    await client.start();
    const states: string[] = [];
    client.subscribe((status) => {
      states.push(status.state);
    });
    fake.emit(createdEvent("a.md"));
    nowValue = 2000;
    fake.emit(changedEvent("b.md"));
    nowValue = 3000;
    fake.emit(rescanEvent(""));
    expect(seen).toEqual(["a.md", "b.md", ""]);
    expect(client.status.lastEventAt).toBe(3000);
    // Events alone never notify status listeners.
    expect(states).toEqual([]);
    client.dispose();
  });

  it("isolates a throwing event handler so later events still arrive", async () => {
    const fake = createFakeWatch();
    const errors: unknown[] = [];
    const seen: string[] = [];
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: (event) => {
        const path = event.paths[0] ?? "";
        if (path === "boom.md") throw new Error("handler boom");
        seen.push(path);
      },
      onError: (error, context) => {
        errors.push([error, context]);
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      shareStatus: false,
    });
    await client.start();
    fake.emit(createdEvent("boom.md"));
    fake.emit(createdEvent("ok.md"));
    expect(seen).toEqual(["ok.md"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as [unknown, string])[1]).toBe("event");
    client.dispose();
  });

  it("dispose calls unwatch once, ignores later events, and reports stopped", async () => {
    const fake = createFakeWatch();
    const seen: string[] = [];
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: (event) => {
        seen.push(event.paths[0] ?? "");
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      shareStatus: false,
    });
    await client.start();
    client.dispose();
    client.dispose();
    fake.emit(createdEvent("late.md"));
    expect(fake.unwatchCalls).toBe(1);
    expect(seen).toEqual([]);
    expect(client.status.state).toBe("stopped");
  });

  it("a watch rejection becomes unavailable status and never rejects start", async () => {
    const fake = createFakeWatch();
    fake.rejectWith = new Error("watch boom");
    const errors: Array<[unknown, string]> = [];
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onError: (error, context) => {
        errors.push([error, context]);
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      shareStatus: false,
    });
    await expect(client.start()).resolves.toBeUndefined();
    expect(client.status.state).toBe("unavailable");
    expect(client.status.detail).toBe("watch boom");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toBe("watch");
    client.dispose();
  });

  it("dispose while watch is pending still closes the late subscription", async () => {
    let resolveWatch: (unwatch: () => void) => void = () => undefined;
    let unwatchCalls = 0;
    const watch: WatcherWatchFn = () =>
      new Promise((resolve) => {
        resolveWatch = resolve;
      });
    const client = createWatcherClient({
      root: "root",
      watch,
      onEvent: () => undefined,
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      shareStatus: false,
    });
    const started = client.start();
    client.dispose();
    resolveWatch(() => {
      unwatchCalls += 1;
    });
    await started;
    expect(unwatchCalls).toBe(1);
    expect(client.status.state).toBe("stopped");
  });

  it("works without window or document sources, with no triggers", async () => {
    const fake = createFakeWatch();
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      mode: "web",
      webSocketAvailable: true,
      windowLike: null,
      documentLike: null,
      shareStatus: false,
    });
    await client.start();
    expect(client.status.state).toBe("active");
    client.dispose();
    expect(client.status.state).toBe("stopped");
  });
});

describe("watcher client resync triggers", () => {
  it("requests resync when the tab becomes visible, not when hidden", async () => {
    const fake = createFakeWatch();
    const documentLike = new FakeDocument();
    const reasons: WatcherResyncReason[] = [];
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onResyncRequested: (reason) => {
        reasons.push(reason);
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike,
      resyncCoalesceMs: 0,
      shareStatus: false,
    });
    await client.start();
    documentLike.visibilityState = "hidden";
    documentLike.emit("visibilitychange");
    documentLike.visibilityState = "visible";
    documentLike.emit("visibilitychange");
    expect(reasons).toEqual(["visibility"]);
    client.dispose();
  });

  it("requests resync on window focus", async () => {
    const fake = createFakeWatch();
    const windowLike = new FakeEventSource();
    const reasons: WatcherResyncReason[] = [];
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onResyncRequested: (reason) => {
        reasons.push(reason);
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike,
      documentLike: new FakeDocument(),
      resyncCoalesceMs: 0,
      shareStatus: false,
    });
    await client.start();
    windowLike.emit("focus");
    expect(reasons).toEqual(["focus"]);
    client.dispose();
  });

  it("online restores the status and requests resync; offline reports offline", async () => {
    const fake = createFakeWatch();
    const windowLike = new FakeEventSource();
    const reasons: WatcherResyncReason[] = [];
    const states: string[] = [];
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onResyncRequested: (reason) => {
        reasons.push(reason);
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike,
      documentLike: new FakeDocument(),
      isOnline: () => true,
      resyncCoalesceMs: 0,
      shareStatus: false,
    });
    await client.start();
    client.subscribe((status) => {
      states.push(status.state);
    });
    windowLike.emit("offline");
    expect(client.status.state).toBe("offline");
    windowLike.emit("online");
    expect(client.status.state).toBe("active");
    expect(reasons).toEqual(["online"]);
    expect(states).toEqual(["offline", "active"]);
    client.dispose();
  });

  it("coalesces trigger bursts inside the debounce window", async () => {
    const fake = createFakeWatch();
    const windowLike = new FakeEventSource();
    const documentLike = new FakeDocument();
    const reasons: WatcherResyncReason[] = [];
    let nowValue = 1000;
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onResyncRequested: (reason) => {
        reasons.push(reason);
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike,
      documentLike,
      now: () => nowValue,
      shareStatus: false,
    });
    await client.start();
    documentLike.emit("visibilitychange");
    windowLike.emit("focus");
    windowLike.emit("online");
    expect(reasons).toEqual(["visibility"]);
    nowValue = 1000 + WATCHER_RESYNC_COALESCE_MS;
    windowLike.emit("focus");
    expect(reasons).toEqual(["visibility", "focus"]);
    client.dispose();
  });

  it("manual resync requests share the same coalescing window", async () => {
    const fake = createFakeWatch();
    const windowLike = new FakeEventSource();
    const reasons: WatcherResyncReason[] = [];
    let nowValue = 5000;
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onResyncRequested: (reason) => {
        reasons.push(reason);
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike,
      documentLike: new FakeDocument(),
      now: () => nowValue,
      shareStatus: false,
    });
    await client.start();
    client.requestResync("manual");
    client.requestResync("manual");
    expect(reasons).toEqual(["manual"]);
    nowValue += WATCHER_RESYNC_COALESCE_MS + 1;
    client.requestResync("manual");
    expect(reasons).toEqual(["manual", "manual"]);
    client.dispose();
  });

  it("ignores resync requests before start, after failure, and after dispose", async () => {
    const fake = createFakeWatch();
    const reasons: WatcherResyncReason[] = [];
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onResyncRequested: (reason) => {
        reasons.push(reason);
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      resyncCoalesceMs: 0,
      shareStatus: false,
    });
    client.requestResync("manual");
    await client.start();
    client.requestResync("manual");
    client.dispose();
    client.requestResync("manual");
    expect(reasons).toEqual(["manual"]);

    const failing = createFakeWatch();
    failing.rejectWith = new Error("no watch");
    const failedReasons: WatcherResyncReason[] = [];
    const failed = createWatcherClient({
      root: "root",
      watch: failing.watch,
      onEvent: () => undefined,
      onResyncRequested: (reason) => {
        failedReasons.push(reason);
      },
      onError: () => undefined,
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      resyncCoalesceMs: 0,
      shareStatus: false,
    });
    await failed.start();
    failed.requestResync("manual");
    expect(failedReasons).toEqual([]);
    failed.dispose();
  });

  it("registers no triggers in Tauri mode and reports the native transport", async () => {
    const fake = createFakeWatch();
    const windowLike = new FakeEventSource();
    const documentLike = new FakeDocument();
    const reasons: WatcherResyncReason[] = [];
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onResyncRequested: (reason) => {
        reasons.push(reason);
      },
      mode: "tauri",
      windowLike,
      documentLike,
      resyncCoalesceMs: 0,
      shareStatus: false,
    });
    await client.start();
    expect(client.status.transport).toBe("native");
    expect(client.status.state).toBe("active");
    expect(windowLike.count("focus")).toBe(0);
    expect(windowLike.count("online")).toBe(0);
    expect(documentLike.count("visibilitychange")).toBe(0);
    windowLike.emit("focus");
    windowLike.emit("online");
    documentLike.emit("visibilitychange");
    expect(reasons).toEqual([]);
    client.dispose();
  });

  it("dispose removes all trigger listeners", async () => {
    const fake = createFakeWatch();
    const windowLike = new FakeEventSource();
    const documentLike = new FakeDocument();
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onResyncRequested: () => undefined,
      mode: "web",
      webSocketAvailable: true,
      windowLike,
      documentLike,
      shareStatus: false,
    });
    await client.start();
    expect(windowLike.count("focus")).toBe(1);
    expect(documentLike.count("visibilitychange")).toBe(1);
    client.dispose();
    expect(windowLike.count("focus")).toBe(0);
    expect(windowLike.count("online")).toBe(0);
    expect(windowLike.count("offline")).toBe(0);
    expect(documentLike.count("visibilitychange")).toBe(0);
  });
});

describe("watcher client fallback status", () => {
  it("reports polling, honestly, when WebSocket is unavailable", async () => {
    const fake = createFakeWatch();
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      mode: "web",
      webSocketAvailable: false,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      shareStatus: false,
    });
    await client.start();
    expect(client.status.state).toBe("polling");
    expect(client.status.transport).toBe("polling");
    const message = watcherStatusMessage(client.status);
    expect(message).toContain("periodically");
    expect(message).not.toContain("live updates are active");
    client.dispose();
  });

  it("reports offline when the browser starts offline, then recovers on online", async () => {
    const fake = createFakeWatch();
    const windowLike = new FakeEventSource();
    let online = false;
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onResyncRequested: () => undefined,
      mode: "web",
      webSocketAvailable: true,
      windowLike,
      documentLike: new FakeDocument(),
      isOnline: () => online,
      resyncCoalesceMs: 0,
      shareStatus: false,
    });
    await client.start();
    expect(client.status.state).toBe("offline");
    online = true;
    windowLike.emit("online");
    expect(client.status.state).toBe("active");
    client.dispose();
  });

  it("treats a throwing online probe as online rather than reporting offline", async () => {
    const fake = createFakeWatch();
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      isOnline: () => {
        throw new Error("probe boom");
      },
      shareStatus: false,
    });
    await client.start();
    expect(client.status.state).toBe("active");
    client.dispose();
  });

  it("status messages stay silent for healthy states and honest for degraded ones", () => {
    expect(watcherStatusMessage(statusWith("starting"))).toBeNull();
    expect(watcherStatusMessage(statusWith("active"))).toBeNull();
    expect(watcherStatusMessage(statusWith("stopped"))).toBeNull();
    expect(watcherStatusMessage(statusWith("polling"))).toBe(
      "Live updates are unavailable in this browser. The file tree checks for changes periodically.",
    );
    expect(watcherStatusMessage(statusWith("offline"))).toBe(
      "You are offline. The file tree will refresh when the connection returns.",
    );
    expect(watcherStatusMessage(statusWith("unavailable"))).toBe(
      "File watching is unavailable. New files from outside may not appear until you refresh the file tree.",
    );
    for (const state of ["polling", "offline", "unavailable"] as const) {
      expect(watcherStatusMessage(statusWith(state))).not.toContain(" ");
    }
  });

  it("onStatusChange receives transitions but not per-event updates", async () => {
    const fake = createFakeWatch();
    const states: string[] = [];
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      onStatusChange: (status) => {
        states.push(status.state);
      },
      mode: "web",
      webSocketAvailable: true,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
      shareStatus: false,
    });
    await client.start();
    fake.emit(createdEvent("a.md"));
    fake.emit(createdEvent("b.md"));
    expect(states).toEqual(["active"]);
    client.dispose();
    expect(states).toEqual(["active", "stopped"]);
  });

  it("publishes transitions into the shared store for the UI", async () => {
    const fake = createFakeWatch();
    const snapshots: string[] = [];
    const unsubscribe = subscribeWatcherStatus(() => {
      snapshots.push(getWatcherStatus().state);
    });
    const client = createWatcherClient({
      root: "root",
      watch: fake.watch,
      onEvent: () => undefined,
      mode: "web",
      webSocketAvailable: false,
      windowLike: new FakeEventSource(),
      documentLike: new FakeDocument(),
    });
    await client.start();
    expect(getWatcherStatus().state).toBe("polling");
    client.dispose();
    expect(getWatcherStatus().state).toBe("stopped");
    expect(snapshots).toEqual(["polling", "stopped"]);
    unsubscribe();
  });

  it("keeps the debounce constants at the designed 300 ms values", () => {
    expect(WATCHER_CLIENT_DELAY_MS).toBe(300);
    expect(WATCHER_RESYNC_COALESCE_MS).toBe(300);
  });
});
