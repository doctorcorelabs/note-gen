// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Index worker loop tests (V3-06 part 3, wave 3B overlap, AD-57).
//
// The loop is tested against fakes only: a fake clock drives every
// timer, a fake scanner stands in for the sibling v3b-06a
// implementation, and a fake heartbeat writer stands in for the
// wave 5 writer. No database, no migration, no heartbeat table, and
// no wall-clock waiting are involved. The tests lock debounce,
// single-flight, graceful shutdown (including shutdown mid-scan),
// heartbeat cadence and independence from scans, failure
// tolerance, and the query-port passthrough the integrator relies
// on when unifying the sibling port interfaces.

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_SCAN_DEBOUNCE_MS,
  DEFAULT_SCAN_INTERVAL_MS,
  IndexWorker,
  WORKER_STALE_THRESHOLD_MS,
  createConsoleIndexWorkerLogger,
  type IndexHeartbeat,
  type IndexHeartbeatWriter,
  type IndexQueryPort,
  type IndexScanInput,
  type IndexScanSummary,
  type IndexScannerPort,
  type IndexWorkerClock,
  type IndexWorkerLogger,
} from '../src/services/index/worker.js';

const SUMMARY: IndexScanSummary = { filesScanned: 3, rowsUpserted: 1, rowsRemoved: 0 };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Drains microtasks and one real-timer tick so scan continuations
// (which run after the fake scanner promise settles) complete.
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

interface FakeTimer {
  id: number;
  due: number;
  callback: () => void;
  cancelled: boolean;
}

class FakeClock implements IndexWorkerClock {
  nowMs = 0;
  private timers: FakeTimer[] = [];
  private nextId = 1;

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const timer: FakeTimer = { id: this.nextId, due: this.nowMs + ms, callback, cancelled: false };
    this.nextId += 1;
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    (handle as FakeTimer).cancelled = true;
  }

  // Advances virtual time, firing every due timer in due order.
  // Timers scheduled by a callback that fall inside the window
  // fire in the same advance, in order.
  advance(ms: number): void {
    const target = this.nowMs + ms;
    let guard = 0;
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.due <= target)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (due === undefined) {
        break;
      }
      due.cancelled = true;
      this.nowMs = due.due;
      due.callback();
      guard += 1;
      if (guard > 10000) {
        throw new Error('fake clock runaway: too many timers fired in one advance');
      }
    }
    this.nowMs = target;
  }

  pendingCount(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}

interface LogEntry {
  level: string;
  event: string;
  fields: Record<string, unknown>;
}

class FakeLogger implements IndexWorkerLogger {
  entries: LogEntry[] = [];

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level: 'info', event, fields });
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level: 'warn', event, fields });
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level: 'error', event, fields });
  }

  events(level: string, event: string): LogEntry[] {
    return this.entries.filter((entry) => entry.level === level && entry.event === event);
  }
}

class FakeScanner implements IndexScannerPort {
  calls: IndexScanInput[] = [];
  active = 0;
  maxActive = 0;
  manual = false;
  pending: Array<ReturnType<typeof deferred<IndexScanSummary>>> = [];
  failuresLeft = 0;

  async scan(input: IndexScanInput): Promise<IndexScanSummary> {
    this.calls.push(input);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.failuresLeft > 0) {
        this.failuresLeft -= 1;
        throw new Error('scan boom');
      }
      if (this.manual) {
        const gate = deferred<IndexScanSummary>();
        this.pending.push(gate);
        return await gate.promise;
      }
      return SUMMARY;
    } finally {
      this.active -= 1;
    }
  }
}

class FakeHeartbeatWriter implements IndexHeartbeatWriter {
  heartbeats: IndexHeartbeat[] = [];
  failuresLeft = 0;

  async writeHeartbeat(heartbeat: IndexHeartbeat): Promise<void> {
    this.heartbeats.push(heartbeat);
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('heartbeat store down');
    }
  }
}

const fakeQuery: IndexQueryPort = {
  resolveVersion: async () => 7,
};

function makeWorker(options: {
  scanner: IndexScannerPort;
  clock: FakeClock;
  logger: FakeLogger;
  heartbeatWriter?: IndexHeartbeatWriter;
  query?: IndexQueryPort;
  scanIntervalMs?: number;
  scanDebounceMs?: number;
  heartbeatIntervalMs?: number;
  scanOnStart?: boolean;
}): IndexWorker {
  return new IndexWorker(
    {
      scanner: options.scanner,
      query: options.query,
      heartbeatWriter: options.heartbeatWriter,
      logger: options.logger,
      clock: options.clock,
    },
    {
      scanIntervalMs: options.scanIntervalMs,
      scanDebounceMs: options.scanDebounceMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      scanOnStart: options.scanOnStart,
      workerId: 'test-worker',
    },
  );
}

describe('index worker defaults', () => {
  it('uses the session cadence defaults: heartbeat 60s, stale 300s, debounce 300ms', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(60000);
    expect(WORKER_STALE_THRESHOLD_MS).toBe(300000);
    expect(WORKER_STALE_THRESHOLD_MS).toBe(5 * DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(DEFAULT_SCAN_DEBOUNCE_MS).toBe(300);
    expect(DEFAULT_SCAN_INTERVAL_MS).toBe(300000);
  });

  it('rejects invalid cadence options at construction', () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    expect(
      () => new IndexWorker({ scanner, logger, clock }, { scanIntervalMs: 0 }),
    ).toThrow(RangeError);
    expect(
      () => new IndexWorker({ scanner, logger, clock }, { heartbeatIntervalMs: 0 }),
    ).toThrow(RangeError);
    expect(
      () => new IndexWorker({ scanner, logger, clock }, { scanDebounceMs: -1 }),
    ).toThrow(RangeError);
    expect(
      () => new IndexWorker({ scanner, logger, clock }, { scanIntervalMs: 1.5 }),
    ).toThrow(RangeError);
  });

  it('requires a scanner port', () => {
    expect(
      () => new IndexWorker({ scanner: undefined as unknown as IndexScannerPort }),
    ).toThrow(TypeError);
  });
});

describe('index worker debounce', () => {
  it('collapses a burst of requests into one scan after a quiet window', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanDebounceMs: 300,
      scanOnStart: false,
    });
    worker.start();
    worker.requestScan('manual');
    worker.requestScan('manual');
    worker.requestScan('manual');
    clock.advance(299);
    expect(scanner.calls).toHaveLength(0);
    clock.advance(1);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    expect(worker.status().scansCompleted).toBe(1);
    await worker.stop();
  });

  it('restarts the quiet window when a request arrives mid-window', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanDebounceMs: 300,
      scanOnStart: false,
    });
    worker.start();
    worker.requestScan('manual');
    clock.advance(200);
    worker.requestScan('manual');
    clock.advance(200);
    expect(scanner.calls).toHaveLength(0);
    clock.advance(100);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    await worker.stop();
  });

  it('runs the startup scan debounced when scanOnStart is true', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const worker = makeWorker({ scanner, clock, logger, scanDebounceMs: 300, scanOnStart: true });
    worker.start();
    expect(scanner.calls).toHaveLength(0);
    clock.advance(300);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    expect(logger.events('info', 'index_scan_started')[0]?.fields['reason']).toBe('startup');
    await worker.stop();
  });
});

describe('index worker periodic scans', () => {
  it('triggers one scan per interval tick', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanIntervalMs: 1000,
      scanDebounceMs: 0,
      scanOnStart: false,
    });
    worker.start();
    clock.advance(1000);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    clock.advance(1000);
    await flush();
    expect(scanner.calls).toHaveLength(2);
    clock.advance(1000);
    await flush();
    expect(scanner.calls).toHaveLength(3);
    await worker.stop();
  });

  it('keeps the periodic cadence anchored to ticks, not to scan completion', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    scanner.manual = true;
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanIntervalMs: 1000,
      scanDebounceMs: 0,
      scanOnStart: false,
    });
    worker.start();
    // First tick starts a scan that stays in flight.
    clock.advance(1000);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    // Second tick arrives while the scan runs: no second scan.
    clock.advance(1000);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    expect(scanner.maxActive).toBe(1);
    // Finishing the scan runs exactly one follow-up for the tick
    // that arrived during the scan, then the cadence continues.
    scanner.pending[0]?.resolve(SUMMARY);
    await flush();
    clock.advance(0);
    await flush();
    expect(scanner.calls).toHaveLength(2);
    scanner.pending[1]?.resolve(SUMMARY);
    await flush();
    clock.advance(1000);
    await flush();
    expect(scanner.calls).toHaveLength(3);
    // The third scan is still in flight: resolve it before stop,
    // because graceful shutdown waits for the running scan.
    scanner.pending[2]?.resolve(SUMMARY);
    await flush();
    await worker.stop();
  });
});

describe('index worker single-flight', () => {
  it('never runs overlapping scans; requests during a scan yield one follow-up', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    scanner.manual = true;
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanIntervalMs: 60000,
      scanDebounceMs: 0,
      scanOnStart: true,
    });
    worker.start();
    clock.advance(0);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    worker.requestScan('manual');
    worker.requestScan('manual');
    worker.requestScan('manual');
    clock.advance(0);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    expect(scanner.maxActive).toBe(1);
    expect(worker.status().pendingScan).toBe(true);
    scanner.pending[0]?.resolve(SUMMARY);
    await flush();
    clock.advance(0);
    await flush();
    expect(scanner.calls).toHaveLength(2);
    expect(scanner.maxActive).toBe(1);
    scanner.pending[1]?.resolve(SUMMARY);
    await flush();
    expect(worker.status().pendingScan).toBe(false);
    expect(worker.status().scansCompleted).toBe(2);
    await worker.stop();
  });

  it('passes the query port and an abort signal through to the scanner', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      query: fakeQuery,
      scanDebounceMs: 0,
      scanOnStart: true,
    });
    worker.start();
    clock.advance(0);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    expect(scanner.calls[0]?.query).toBe(fakeQuery);
    expect(scanner.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(scanner.calls[0]?.signal.aborted).toBe(false);
    await worker.stop();
  });
});

describe('index worker graceful shutdown', () => {
  it('aborts a scan in flight and waits for it to settle before resolving', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    let observedSignal: AbortSignal | undefined;
    const abortAware: IndexScannerPort = {
      scan: async (input: IndexScanInput) => {
        observedSignal = input.signal;
        return new Promise<IndexScanSummary>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(SUMMARY), { once: true });
        });
      },
    };
    const worker = makeWorker({
      scanner: abortAware,
      clock,
      logger,
      scanDebounceMs: 0,
      scanOnStart: true,
    });
    worker.start();
    clock.advance(0);
    await flush();
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
    const stopping = worker.stop();
    expect(observedSignal?.aborted).toBe(true);
    await stopping;
    expect(worker.status().state).toBe('stopped');
    expect(worker.status().scansCompleted).toBe(1);
    // No further scans or timers fire after stop.
    clock.advance(3600000);
    await flush();
    expect(worker.status().scansStarted).toBe(1);
    expect(clock.pendingCount()).toBe(0);
  });

  it('waits for a scanner that ignores the abort signal', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    scanner.manual = true;
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanDebounceMs: 0,
      scanOnStart: true,
    });
    worker.start();
    clock.advance(0);
    await flush();
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    scanner.pending[0]?.resolve(SUMMARY);
    await stopping;
    expect(stopped).toBe(true);
    expect(worker.status().state).toBe('stopped');
  });

  it('cancels a debounced scan that has not fired yet', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanDebounceMs: 300,
      scanOnStart: false,
    });
    worker.start();
    worker.requestScan('manual');
    await worker.stop();
    clock.advance(10000);
    await flush();
    expect(scanner.calls).toHaveLength(0);
    expect(clock.pendingCount()).toBe(0);
  });

  it('ignores scan requests after stop and cannot be restarted', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const worker = makeWorker({ scanner, clock, logger, scanDebounceMs: 0, scanOnStart: false });
    worker.start();
    await worker.stop();
    worker.requestScan('manual');
    clock.advance(1000);
    await flush();
    expect(scanner.calls).toHaveLength(0);
    expect(logger.events('warn', 'index_worker_scan_request_ignored')).toHaveLength(1);
    expect(() => worker.start()).toThrow('cannot be restarted');
  });

  it('stop is idempotent and start while running does not duplicate timers', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanIntervalMs: 1000,
      scanDebounceMs: 0,
      scanOnStart: false,
    });
    worker.start();
    worker.start();
    expect(logger.events('warn', 'index_worker_already_started')).toHaveLength(1);
    clock.advance(1000);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    await Promise.all([worker.stop(), worker.stop()]);
    expect(worker.status().state).toBe('stopped');
  });
});

describe('index worker heartbeat seam', () => {
  it('calls the heartbeat writer immediately and then on cadence, via the fake clock', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const writer = new FakeHeartbeatWriter();
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      heartbeatWriter: writer,
      heartbeatIntervalMs: 60000,
      scanOnStart: false,
    });
    worker.start();
    await flush();
    expect(writer.heartbeats).toHaveLength(1);
    expect(writer.heartbeats[0]).toEqual({ workerId: 'test-worker', atMs: 0, scansStarted: 0 });
    clock.advance(59999);
    await flush();
    expect(writer.heartbeats).toHaveLength(1);
    clock.advance(1);
    await flush();
    expect(writer.heartbeats).toHaveLength(2);
    expect(writer.heartbeats[1]?.atMs).toBe(60000);
    clock.advance(120000);
    await flush();
    expect(writer.heartbeats.map((heartbeat) => heartbeat.atMs)).toEqual([0, 60000, 120000, 180000]);
    expect(writer.heartbeats.every((heartbeat) => heartbeat.workerId === 'test-worker')).toBe(true);
    await worker.stop();
    clock.advance(60000);
    await flush();
    expect(writer.heartbeats).toHaveLength(4);
  });

  it('keeps heartbeating while a scan is in flight', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    scanner.manual = true;
    const writer = new FakeHeartbeatWriter();
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      heartbeatWriter: writer,
      heartbeatIntervalMs: 60000,
      scanIntervalMs: 3600000,
      scanDebounceMs: 0,
      scanOnStart: true,
    });
    worker.start();
    clock.advance(0);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    expect(worker.status().scanning).toBe(true);
    clock.advance(60000);
    await flush();
    expect(writer.heartbeats).toHaveLength(2);
    clock.advance(60000);
    await flush();
    expect(writer.heartbeats).toHaveLength(3);
    expect(worker.status().scanning).toBe(true);
    scanner.pending[0]?.resolve(SUMMARY);
    await flush();
    await worker.stop();
  });

  it('logs heartbeat failures and retries on the next tick without stopping scans', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const writer = new FakeHeartbeatWriter();
    writer.failuresLeft = 1;
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      heartbeatWriter: writer,
      heartbeatIntervalMs: 60000,
      scanIntervalMs: 60000,
      scanDebounceMs: 0,
      scanOnStart: true,
    });
    worker.start();
    await flush();
    clock.advance(0);
    await flush();
    expect(logger.events('error', 'index_worker_heartbeat_failed')).toHaveLength(1);
    expect(scanner.calls).toHaveLength(1);
    clock.advance(60000);
    await flush();
    expect(writer.heartbeats).toHaveLength(2);
    expect(logger.events('info', 'index_worker_heartbeat')).toHaveLength(1);
    expect(scanner.calls).toHaveLength(2);
    await worker.stop();
  });

  it('runs scans without a writer and warns once that the seam is unwired', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanDebounceMs: 0,
      scanOnStart: true,
    });
    worker.start();
    clock.advance(0);
    await flush();
    expect(scanner.calls).toHaveLength(1);
    expect(logger.events('warn', 'index_worker_no_heartbeat_writer')).toHaveLength(1);
    await worker.stop();
  });
});

describe('index worker failure tolerance', () => {
  it('logs a failed scan and keeps the periodic cadence running', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    scanner.failuresLeft = 1;
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanIntervalMs: 1000,
      scanDebounceMs: 0,
      scanOnStart: true,
    });
    worker.start();
    clock.advance(0);
    await flush();
    expect(logger.events('error', 'index_scan_failed')).toHaveLength(1);
    expect(worker.status().scansFailed).toBe(1);
    clock.advance(1000);
    await flush();
    expect(scanner.calls).toHaveLength(2);
    expect(worker.status().scansCompleted).toBe(1);
    expect(worker.status().lastScanSummary).toEqual(SUMMARY);
    await worker.stop();
  });

  it('reports status counts honestly across success and failure', async () => {
    const clock = new FakeClock();
    const logger = new FakeLogger();
    const scanner = new FakeScanner();
    scanner.failuresLeft = 1;
    const worker = makeWorker({
      scanner,
      clock,
      logger,
      scanDebounceMs: 0,
      scanOnStart: false,
    });
    worker.start();
    worker.requestScan('manual');
    clock.advance(0);
    await flush();
    worker.requestScan('manual');
    clock.advance(0);
    await flush();
    const status = worker.status();
    expect(status.scansStarted).toBe(2);
    expect(status.scansFailed).toBe(1);
    expect(status.scansCompleted).toBe(1);
    expect(status.scanning).toBe(false);
    expect(status.lastScanAtMs).toBe(0);
    await worker.stop();
  });
});

describe('index worker structured logging', () => {
  it('writes one parseable JSON object per line with level and event', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const logger = createConsoleIndexWorkerLogger();
      logger.info('index_scan_completed', { filesScanned: 3 });
      logger.error('index_scan_failed', { errorName: 'Error' });
      const stdoutLine = String(stdoutWrite.mock.calls[0]?.[0]);
      const stderrLine = String(stderrWrite.mock.calls[0]?.[0]);
      const stdoutEntry = JSON.parse(stdoutLine) as Record<string, unknown>;
      const stderrEntry = JSON.parse(stderrLine) as Record<string, unknown>;
      expect(stdoutEntry['level']).toBe('info');
      expect(stdoutEntry['event']).toBe('index_scan_completed');
      expect(stdoutEntry['filesScanned']).toBe(3);
      expect(typeof stdoutEntry['ts']).toBe('string');
      expect(stderrEntry['level']).toBe('error');
      expect(stderrEntry['event']).toBe('index_scan_failed');
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });
});
