// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Unit tests for the write queue and the coalescing event sink
// (V3-04b). The queue serializes writes per path in FIFO order with
// a wait timeout; the sink coalesces post-write events (latest per
// path, 250 ms quiet window, 2000 ms maximum delay) without ever
// merging, dropping, or reordering the HTTP writes themselves.

import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/plugins/envelope.js';
import {
  CoalescingEventSink,
  DEFAULT_COALESCE_MAX_DELAY_MS,
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
  WriteQueue,
} from '../src/services/workspace/write-queue.js';
import type { WorkspaceWriteEvent } from '../src/services/workspace/write-ports.js';
import { FakeEventPort } from './helpers/workspace-test-ports.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function event(path: string, revision: string): WorkspaceWriteEvent {
  return { kind: 'changed', path, revision, version: 1, actorId: 'actor-1' };
}

describe('WriteQueue', () => {
  it('runs tasks for the same key in FIFO order and never concurrently', async () => {
    const queue = new WriteQueue();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const task = (name: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(10);
      order.push(name);
      active -= 1;
      return name;
    };
    const results = await Promise.all([
      queue.run('a.md', task('first')),
      queue.run('a.md', task('second')),
      queue.run('a.md', task('third')),
    ]);
    expect(results).toEqual(['first', 'second', 'third']);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(maxActive).toBe(1);
  });

  it('runs tasks for different keys concurrently', async () => {
    const queue = new WriteQueue();
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active -= 1;
    };
    await Promise.all([queue.run('a.md', task), queue.run('b.md', task)]);
    expect(maxActive).toBe(2);
  });

  it('releases the key when a task throws, so the next waiter proceeds', async () => {
    const queue = new WriteQueue();
    await expect(queue.run('a.md', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(queue.pendingCount('a.md')).toBe(0);
    await expect(queue.run('a.md', async () => 'ok')).resolves.toBe('ok');
  });

  it('answers 503 write_queue_timeout when a waiter exceeds the wait timeout', async () => {
    const queue = new WriteQueue({ waitTimeoutMs: 20 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = queue.run('a.md', async () => {
      await gate;
      return 'held';
    });
    await expect(queue.run('a.md', async () => 'late')).rejects.toMatchObject({
      statusCode: 503,
      code: 'write_queue_timeout',
    });
    expect(queue.pendingCount('a.md')).toBe(0);
    release();
    await expect(holder).resolves.toBe('held');
  });

  it('keeps the waiter behind a timed-out waiter in line', async () => {
    const queue = new WriteQueue({ waitTimeoutMs: 20 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = queue.run('a.md', () => gate);
    const timedOut = queue.run('a.md', async () => 'never');
    const survivor = queue.run('a.md', async () => 'survived');
    await expect(timedOut).rejects.toBeInstanceOf(ApiError);
    release();
    await holder;
    await expect(survivor).resolves.toBe('survived');
  });

  it('uses the 30s default wait timeout', () => {
    expect(DEFAULT_QUEUE_WAIT_TIMEOUT_MS).toBe(30000);
  });
});

describe('CoalescingEventSink', () => {
  it('uses the F1-23 defaults: 250 ms quiet window, 2000 ms maximum delay', () => {
    expect(DEFAULT_COALESCE_WINDOW_MS).toBe(250);
    expect(DEFAULT_COALESCE_MAX_DELAY_MS).toBe(2000);
  });

  it('publishes the latest event per path after the quiet window', async () => {
    const port = new FakeEventPort();
    const sink = new CoalescingEventSink(port, { coalesceWindowMs: 10, maxDelayMs: 100 });
    sink.note(event('a.md', 'rev-1'));
    sink.note(event('a.md', 'rev-2'));
    sink.note(event('b.md', 'rev-1'));
    expect(sink.pendingCount()).toBe(2);
    await sleep(40);
    expect(port.batches).toHaveLength(1);
    expect(port.all).toHaveLength(2);
    expect(port.all.find((e) => e.path === 'a.md')?.revision).toBe('rev-2');
    expect(port.all.find((e) => e.path === 'b.md')?.revision).toBe('rev-1');
    expect(sink.pendingCount()).toBe(0);
  });

  it('flushes at the maximum delay even under a continuous stream of notes', async () => {
    const port = new FakeEventPort();
    const sink = new CoalescingEventSink(port, { coalesceWindowMs: 50, maxDelayMs: 60 });
    sink.note(event('a.md', 'rev-1'));
    for (let i = 0; i < 6; i += 1) {
      await sleep(15);
      sink.note(event('a.md', `rev-${i + 2}`));
    }
    await sleep(20);
    expect(port.batches.length).toBeGreaterThanOrEqual(1);
    expect(port.all[0]?.revision).not.toBe('rev-1');
  });

  it('flush() publishes immediately and a note during flush starts a new burst', async () => {
    const port = new FakeEventPort();
    const sink = new CoalescingEventSink(port, { coalesceWindowMs: 1000, maxDelayMs: 2000 });
    sink.note(event('a.md', 'rev-1'));
    await sink.flush();
    expect(port.all).toHaveLength(1);
    sink.note(event('a.md', 'rev-2'));
    expect(sink.pendingCount()).toBe(1);
    await sink.flush();
    expect(port.all).toHaveLength(2);
    expect(port.all[1]?.revision).toBe('rev-2');
  });

  it('swallows a publication failure and drops the buffered events', async () => {
    const onFlushError = vi.fn();
    const failing = {
      publish: () => {
        throw new Error('fan-out down');
      },
    };
    const sink = new CoalescingEventSink(failing, {
      coalesceWindowMs: 5,
      maxDelayMs: 10,
      onFlushError,
    });
    sink.note(event('a.md', 'rev-1'));
    await sleep(30);
    expect(onFlushError).toHaveBeenCalledTimes(1);
    expect(sink.pendingCount()).toBe(0);
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  it('accepts notes and drops them when no event port is wired', async () => {
    const sink = new CoalescingEventSink(undefined, { coalesceWindowMs: 5, maxDelayMs: 10 });
    sink.note(event('a.md', 'rev-1'));
    expect(sink.pendingCount()).toBe(1);
    await sleep(20);
    expect(sink.pendingCount()).toBe(0);
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});
