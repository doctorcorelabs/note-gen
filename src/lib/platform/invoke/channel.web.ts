// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import type { ChannelAdapter, ChannelHandle } from "./interface";

/**
 * Web implementation of the channel adapter (G2 surface; 3D
 * follow-up C2 from the G2 review, rev2b note C2).
 *
 * createChannel is canonical (AD-31, decision D-02): call sites
 * build a channel handle and pass it nested in invoke arguments,
 * and the SSE transport stays hidden behind this surface. The
 * InvokeStreamAdapter stream surface on WebInvokeAdapter is a
 * different interface and must never be registered as the channel
 * adapter (see wiring.ts).
 *
 * MVP behavior is deliberately inert: a handle carries a unique id
 * and the callback the caller supplied, and no message is ever
 * delivered through it, because no SSE subscription exists in the
 * MVP. That is honest rather than silent: the only command that
 * takes a channel, ai_chat_completion_stream, is a reserved stream
 * route, and the web invoke adapter rejects it explicitly with a
 * not_implemented stream error before argument validation, so the
 * caller always sees the failure instead of an empty stream. The
 * SSE subscription behind this surface is a later-phase follow-up
 * (the route is phase 2); this file invents no transport.
 *
 * Ids come from one module-level counter shared by every adapter
 * instance, mirroring the upstream Channel allocation, so handles
 * stay unique even when wiring runs twice before the freeze. Ids
 * are opaque: callers must not parse them.
 *
 * The factory takes no arguments and performs no I/O, matching the
 * wiring pattern. The declared return type keeps the object
 * assignable to ChannelAdapter, so a signature drift fails
 * typecheck.
 */

let nextChannelId = 1;

function noopChannelHandler(): void {
  // No delivery in the MVP; see the module doc comment above.
}

export class WebChannelAdapter implements ChannelAdapter {
  createChannel<T = unknown>(
    onmessage?: (response: T) => void,
  ): ChannelHandle<T> {
    const id = nextChannelId;
    nextChannelId += 1;
    return {
      id,
      onmessage: onmessage ?? noopChannelHandler,
    };
  }
}

export function createWebChannelAdapter(): ChannelAdapter {
  return new WebChannelAdapter();
}
