// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the web channel adapter, using the repo convention
 * (node:test with node:assert/strict). Run through an esbuild
 * bundle first, as in router.spec.ts:
 *
 * ./node_modules/.bin/esbuild src/lib/platform/invoke/channel.web.spec.ts \
 *   --bundle --platform=node --format=esm \
 *   --outfile=/tmp/invoke-channel.spec.mjs \
 * && node --test /tmp/invoke-channel.spec.mjs
 *
 * No test in this file sends HTTP or opens a stream: the stream
 * command rejects locally before any transport exists, and the
 * channel handles themselves perform no I/O.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PlatformCapabilityError } from "../errors";
import { createWebChannelAdapter, WebChannelAdapter } from "./channel.web";
import { createWebInvokeAdapter } from "./web";

describe("createWebChannelAdapter", () => {
  test("returns a ChannelAdapter with createChannel", () => {
    const adapter = createWebChannelAdapter();
    assert.equal(adapter instanceof WebChannelAdapter, true);
    assert.equal(typeof adapter.createChannel, "function");
  });

  test("createChannel keeps the supplied callback on the handle", () => {
    const adapter = createWebChannelAdapter();
    const received: string[] = [];
    const handle = adapter.createChannel<string>((response) => {
      received.push(response);
    });
    assert.equal(typeof handle.id, "number");
    assert.equal(Number.isInteger(handle.id), true);
    assert.ok(handle.id > 0);
    handle.onmessage("hello");
    assert.deepEqual(received, ["hello"]);
  });

  test("createChannel without a callback returns a callable no-op", () => {
    const adapter = createWebChannelAdapter();
    const handle = adapter.createChannel<string>();
    assert.equal(typeof handle.onmessage, "function");
    assert.doesNotThrow(() => handle.onmessage("dropped"));
  });

  test("handles carry unique increasing ids across adapters", () => {
    const first = createWebChannelAdapter();
    const second = createWebChannelAdapter();
    const a = first.createChannel();
    const b = first.createChannel();
    const c = second.createChannel();
    assert.notEqual(a, b);
    assert.ok(b.id > a.id);
    assert.ok(c.id > b.id);
    assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  });

  test("onmessage is reassignable on the handle", () => {
    const adapter = createWebChannelAdapter();
    const handle = adapter.createChannel<string>();
    const received: string[] = [];
    handle.onmessage = (response) => {
      received.push(response);
    };
    handle.onmessage("again");
    assert.deepEqual(received, ["again"]);
  });

  test("a handle is a plain id plus onmessage object", () => {
    const adapter = createWebChannelAdapter();
    const handle = adapter.createChannel();
    assert.deepEqual(Object.keys(handle).sort(), ["id", "onmessage"]);
  });
});

describe("channel handle through the invoke router", () => {
  test("the stream command rejects explicitly with the handle nested in args", async () => {
    const channel = createWebChannelAdapter().createChannel();
    const invoke = createWebInvokeAdapter();
    let caught: unknown = undefined;
    try {
      await invoke.invoke("ai_chat_completion_stream", {
        request: { config: {}, requestId: "test", body: null },
        onEvent: channel,
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught instanceof PlatformCapabilityError, true);
    assert.equal(
      (caught as PlatformCapabilityError).code,
      "not_implemented",
    );
  });
});
