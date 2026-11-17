// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Transport-neutral fan-out hub for workspace file-change
// events (W4-WIRE, V3-08 part 2 remainder). The hub owns the
// per-process event ring buffer and the set of live
// connections; the WebSocket route module adapts sockets to
// it, and future producers (the chokidar watcher, the write
// path) publish through it.
//
// Scoping: connections are grouped by the authenticated
// userId, never broadcast across accounts. No workspace
// identity resolution is wired in this slot (producers cannot
// attribute events to a workspace yet), so the userId scope is
// the honest MVP boundary: one user, one workspace, no leak.
// A published event reaches every live connection of the same
// user, including the connection that triggered the write
// (actor attribution distinguishes self from other).
//
// No producer is wired in this slot: publish() exists for the
// watcher/write-path work that follows, and the ring buffer
// stays empty until then. The resync path is live from day
// one: a client that reconnects replays from the buffer, or
// gets resync-required when the buffer cannot satisfy it.

import {
  buildWorkspaceFileChanged,
  EventRingBuffer,
  InMemorySeqAllocator,
  type ServerMessage,
  type WireEventDraft,
  type WorkspaceFileChangedMessage,
} from './watcher-protocol.js';

export interface HubConnection {
  readonly connectionId: string;
  readonly userId: string;
  send(message: ServerMessage): void;
}

export class WorkspaceEventsHub {
  readonly #buffer: EventRingBuffer;
  readonly #allocator = new InMemorySeqAllocator();
  readonly #connections = new Set<HubConnection>();

  constructor(buffer: EventRingBuffer = new EventRingBuffer()) {
    this.#buffer = buffer;
  }

  get lastSeq(): number {
    return this.#buffer.lastSeq;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get buffer(): EventRingBuffer {
    return this.#buffer;
  }

  attach(connection: HubConnection): void {
    this.#connections.add(connection);
  }

  detach(connection: HubConnection): void {
    this.#connections.delete(connection);
  }

  // Publish one event to the buffer and to every live
  // connection of the owning user. The seq comes from the
  // in-memory allocator; the Postgres sequence migration
  // belongs to a later worker (watcher-protocol.ts seam).
  async publish(userId: string, draft: WireEventDraft): Promise<WorkspaceFileChangedMessage> {
    const event = buildWorkspaceFileChanged({ ...draft, seq: await this.#allocator.next() });
    this.#buffer.append(event);
    for (const connection of this.#connections) {
      if (connection.userId === userId) {
        connection.send(event);
      }
    }
    return event;
  }
}
