// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Tests for the no-op sandboxed frame capability channel (AD-14, F8
// section 5.2 item 3, W4-SEC). The channel offers no capability: every
// well-formed request receives an error reply, no session is ever
// created, and dispose silences the channel. The requests below use a
// neutral method name on purpose; the handler rejects every method,
// so no forbidden literal is needed to prove the behavior.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { describe, expect, it } from "vitest";

import { connectPluginFrameCapabilities } from "./frame-capabilities";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("plugin frame capabilities (no-op)", () => {
  it("replies with an error to every capability request", async () => {
    const channel = new MessageChannel();
    const received: unknown[] = [];
    channel.port2.onmessage = (event: MessageEvent) => {
      received.push(event.data);
    };
    channel.port2.start();
    const capabilities = await connectPluginFrameCapabilities({ port: channel.port1 });
    capabilities.handle({ id: 7, method: "notes.read" });
    await nextTick();
    expect(received).toEqual([{ id: 7, error: "Capability unavailable" }]);
    capabilities.dispose();
    channel.port1.close();
    channel.port2.close();
  });

  it("ignores malformed requests without replying", async () => {
    const channel = new MessageChannel();
    const received: unknown[] = [];
    channel.port2.onmessage = (event: MessageEvent) => {
      received.push(event.data);
    };
    channel.port2.start();
    const capabilities = await connectPluginFrameCapabilities({ port: channel.port1 });
    capabilities.handle({ method: "notes.read" });
    capabilities.handle({ id: 1.5, method: "notes.read" });
    capabilities.handle({ id: 2 });
    await nextTick();
    expect(received).toEqual([]);
    capabilities.dispose();
    channel.port1.close();
    channel.port2.close();
  });

  it("stops replying after dispose", async () => {
    const channel = new MessageChannel();
    const received: unknown[] = [];
    channel.port2.onmessage = (event: MessageEvent) => {
      received.push(event.data);
    };
    channel.port2.start();
    const capabilities = await connectPluginFrameCapabilities({ port: channel.port1 });
    capabilities.dispose();
    capabilities.handle({ id: 3, method: "notes.read" });
    await nextTick();
    expect(received).toEqual([]);
    channel.port1.close();
    channel.port2.close();
  });
});
