// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Server-side write queue (V3-04b, wave 3A).
//
// Two mechanisms live here, and they must not be confused:
//
// 1. WriteQueue: per-path FIFO serialization (desain-workspace-api.md
//    section 3.6). At most one writer runs per normalized path; other
//    writers for the same path wait in arrival order. Different paths
//    stay parallel. Serialization prevents interleaved bytes; it does
//    NOT replace the revision guard, which is evaluated inside the
//    queued task after re-reading current state. A writer that waits
//    longer than the queue timeout fails with 503 write_queue_timeout
//    (retryable, backoff per the contract catalog); the default
//    timeout is 30 seconds, from desain-workspace-api.md section 3.6
//    and kontrak-api-kanonis.md section 6.2. The queue is in-process
//    (single API instance, desain assumption A8); distributing it is
//    Fase 2 work.
//
// 2. CoalescingEventSink: F1-23 semantics applied to post-write
//    follow-ups (PROGRESS 22:41 WIB; desain-store-adapter.md section
//    5.2). Rapid writes to the same path collapse into ONE trailing
//    event carrying the latest revision: the sink waits for a 250 ms
//    quiet window after the last note, bounded by 2000 ms since the
//    first buffered note, so a continuous stream still flushes.
//    Coalescing applies ONLY to event publication. It never merges,
//    drops, or reorders HTTP writes: every request keeps its own
//    guard evaluation, its own disk write, and its own server
//    confirmation. A "saved" answer is only sent after the disk
//    write (and the index transaction, when wired) succeeds.

import { ApiError } from '../../plugins/envelope.js';
import type { WorkspaceEventPort, WorkspaceWriteEvent } from './write-ports.js';

export const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 30000;
export const DEFAULT_COALESCE_WINDOW_MS = 250;
export const DEFAULT_COALESCE_MAX_DELAY_MS = 2000;

export interface WriteQueueOptions {
  waitTimeoutMs?: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export class WriteQueue {
  private readonly waitTimeoutMs: number;
  private readonly active = new Set<string>();
  private readonly waiters = new Map<string, Waiter[]>();

  constructor(options: WriteQueueOptions = {}) {
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS;
  }

  // Runs task holding the per-path lock for key. FIFO: waiters are
  // admitted in arrival order. A timed-out waiter is removed from
  // the line without disturbing the waiter behind it.
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      return await task();
    } finally {
      this.release(key);
    }
  }

  // Number of writers waiting for key (excluding the active one).
  // Used by tests and by operators diagnosing a hot path.
  pendingCount(key: string): number {
    return this.waiters.get(key)?.length ?? 0;
  }

  private acquire(key: string): Promise<void> {
    if (!this.active.has(key)) {
      this.active.add(key);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          clearTimeout(waiter.timer);
          resolve();
        },
        reject: (error: unknown) => {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          clearTimeout(waiter.timer);
          reject(error);
        },
        timer: setTimeout(() => {
          const line = this.waiters.get(key);
          if (line !== undefined) {
            const at = line.indexOf(waiter);
            if (at !== -1) {
              line.splice(at, 1);
            }
            if (line.length === 0) {
              this.waiters.delete(key);
            }
          }
          waiter.reject(ApiError.writeQueueTimeout());
        }, this.waitTimeoutMs),
        settled: false,
      };
      const line = this.waiters.get(key);
      if (line === undefined) {
        this.waiters.set(key, [waiter]);
      } else {
        line.push(waiter);
      }
    });
  }

  private release(key: string): void {
    const line = this.waiters.get(key);
    const next = line?.shift();
    if (line !== undefined && line.length === 0) {
      this.waiters.delete(key);
    }
    if (next === undefined) {
      this.active.delete(key);
      return;
    }
    // The lock stays held: ownership passes to the next waiter,
    // whose acquire promise resolves now.
    next.resolve();
  }
}

export interface CoalescingSinkOptions {
  coalesceWindowMs?: number;
  maxDelayMs?: number;
  // Called when a flush publication throws. Publication is best
  // effort (desain-workspace-api.md section 3.7 step 9): a failure
  // never fails the write that produced the event, and buffered
  // events are dropped after a failed flush rather than retried
  // forever. The default swallows the error silently; production
  // wiring may pass a logger here.
  onFlushError?: (error: unknown) => void;
}

// Buffers workspace change events and publishes the latest event per
// path after a quiet window, bounded by a maximum delay. When no
// event port is wired, notes are accepted and dropped: the sink
// stays a harmless no-op until V3-08 lands the publisher.
export class CoalescingEventSink {
  private readonly events: WorkspaceEventPort | undefined;
  private readonly coalesceWindowMs: number;
  private readonly maxDelayMs: number;
  private readonly onFlushError: (error: unknown) => void;
  private readonly buffered = new Map<string, WorkspaceWriteEvent>();
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;

  constructor(events: WorkspaceEventPort | undefined, options: CoalescingSinkOptions = {}) {
    this.events = events;
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_COALESCE_MAX_DELAY_MS;
    this.onFlushError = options.onFlushError ?? (() => undefined);
  }

  note(event: WorkspaceWriteEvent): void {
    // A note that finds an empty buffer starts a new burst, even
    // when a previous burst is still flushing: the buffer was
    // already drained for that flush.
    const startsBurst = this.buffered.size === 0;
    this.buffered.set(event.path, event);
    if (this.quietTimer !== undefined) {
      clearTimeout(this.quietTimer);
    }
    this.quietTimer = setTimeout(() => {
      void this.flush();
    }, this.coalesceWindowMs);
    // The maximum-delay timer is set once, on the first buffered
    // event of a burst, and is never extended by later notes.
    if (startsBurst && this.maxTimer === undefined) {
      this.maxTimer = setTimeout(() => {
        void this.flush();
      }, this.maxDelayMs);
    }
  }

  pendingCount(): number {
    return this.buffered.size;
  }

  // Publishes all buffered events now (latest per path, in first-note
  // order) and clears the timers. Safe to call when empty.
  async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }
    if (this.quietTimer !== undefined) {
      clearTimeout(this.quietTimer);
      this.quietTimer = undefined;
    }
    if (this.maxTimer !== undefined) {
      clearTimeout(this.maxTimer);
      this.maxTimer = undefined;
    }
    if (this.buffered.size === 0) {
      return;
    }
    const batch = [...this.buffered.values()];
    this.buffered.clear();
    if (this.events === undefined) {
      return;
    }
    this.flushing = true;
    try {
      await this.events.publish(batch);
    } catch (error) {
      this.onFlushError(error);
    } finally {
      this.flushing = false;
    }
  }
}
