// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Index worker loop (V3-06 part 3, wave 3B overlap, AD-57).
//
// This module owns ONLY the background loop that keeps the files
// index fresh: periodic scan triggers, debounce of scan requests,
// single-flight execution (no overlapping scans), graceful shutdown,
// structured logging, and the heartbeat-writer seam. It does NOT
// deploy anything, it does NOT start an HTTP server, and it does NOT
// touch server/src/app.ts or server/src/server.ts: wiring the loop
// into a worker entrypoint is integrator work.
//
// Topology (design 10-build-deploy.md section 3): the worker is a
// separate service running the same image as the API with a
// different command, with no HTTP port. Its liveness is judged by
// the heartbeat it writes, read by the API readiness endpoint
// (checks.ts promotion contract, V3-39c). This loop is the part
// that runs inside that service; compose and entrypoint changes
// belong to wave 5 / T16, not to this task.
//
// Port ownership. The scanner and query implementations belong to
// sibling workers v3b-06a and v3b-06b on other branches. This
// module defines MINIMAL LOCAL port interfaces with the documented
// shapes only, so the loop is testable before those branches land,
// and the integrator unifies the interfaces when wiring the real
// implementations. Do not edit the sibling files from here; do not
// treat these local shapes as a rival canonical contract.
//
// Documented shapes consumed here:
// - Query: resolveVersion(path) returning the current index version
//   or null, the injection shape named by read.ts
//   (WorkspaceReaderDeps.resolveVersion, "injected by V3-06") and
//   the read half of WorkspaceIndexPort.currentVersion in
//   write-ports.ts. The worker passes its query port through to
//   the scanner, which compares disk state against index state.
// - Scanner: one scan run that reconciles disk against the index
//   and reports counts. Rebuild, drift detection, and
//   reconciliation are V3-06 work per write-index-pg.ts; this loop
//   only decides WHEN a scan runs and guarantees AT MOST ONE runs
//   at a time. The scanner receives an AbortSignal so shutdown can
//   ask a running scan to stop early; a scanner that ignores the
//   signal is still awaited to completion by stop().
//
// Heartbeat seam (interface only). The heartbeat writer is an
// injected port; this module creates NO heartbeat table, NO
// migration, and NO database access. The table name, row shape,
// and writer implementation are FUTURE work (wave 5 / T16, K-13
// open) under the checks.ts promotion contract: fresh means ok,
// older than 300000 ms means fail with WORKER_STALE, no row means
// fail with WORKER_NO_HEARTBEAT. The seam exists so the wave 5
// writer plugs in without changing this loop: the integrator
// supplies a writer that persists each heartbeat the loop emits.
// Until a writer is wired, the loop logs one warning at start and
// runs scans without heartbeats; it never claims a heartbeat was
// written when none was.
//
// Cadence defaults (session defaults, O-06 / desain-auth.md
// section 8.2 / desain-backup-hardening.md section 8.3):
// - Heartbeat interval 60000 ms. The stale threshold is 300000 ms,
//   five times the interval, so one or two missed writes do not
//   fail readiness while a dead worker is still detected in five
//   minutes. The worker does NOT enforce the threshold; the ready
//   check does. WORKER_STALE_THRESHOLD_MS is exported only so the
//   ratio stays visible next to the interval.
// - The heartbeat timer is INDEPENDENT of scan execution: a long
//   scan must not by itself make the heartbeat stale, and a stuck
//   scan loop must not keep heartbeats flowing from scan
//   completions. Heartbeats fire from their own timer chain, plus
//   one immediate write at start so a fresh deploy is visible
//   without waiting a full interval.
// - Scan debounce 300 ms, matching the watcher debounce in
//   design 03-workspace-server.md section 4: bursts of change
//   notifications collapse into one scan after a quiet window.
// - Periodic scan interval 300000 ms. This is a WORKER-LOCAL
//   default, not a frozen contract value: the write path already
//   upserts the index synchronously (write-index-pg.ts), so the
//   periodic scan is only a safety net for out-of-API disk
//   changes. The integrator may override it. It is deliberately
//   separate from the heartbeat interval and the stale threshold.
//
// Logging. Structured only: every line carries a level, an event
// name, and fields. No absolute paths, no DSN fragments, no
// credential values, and no raw scanner internals are logged. The
// default logger writes one JSON object per line. Callers that
// already own a logger inject an adapter for IndexWorkerLogger.

// Heartbeat write interval: 60 seconds (O-06 session default).
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60000;

// Stale threshold applied by the readiness check, not by this
// loop: 5 minutes (checks.ts promotion contract, V3-39c).
export const WORKER_STALE_THRESHOLD_MS = 300000;

// Debounce window for scan requests: 300 ms (design 03 section 4).
export const DEFAULT_SCAN_DEBOUNCE_MS = 300;

// Periodic safety-net scan interval: 5 minutes. Worker-local
// default; see the header comment. Not a frozen contract value.
export const DEFAULT_SCAN_INTERVAL_MS = 300000;

// One heartbeat emission. The wave 5 writer decides how this is
// persisted; the shape intentionally carries no table or column
// names, because K-13 leaves those open.
export interface IndexHeartbeat {
  // Stable identity of this worker process, for operators telling
  // two worker processes apart in the heartbeat store.
  workerId: string;
  // Emission time as milliseconds since the Unix epoch, from the
  // injected clock (Date.now() in production).
  atMs: number;
  // Number of scans started by this worker before this heartbeat.
  // Lets an operator tell a live-but-idle worker from a worker
  // whose scan loop is stuck: the count grows only when scans run.
  scansStarted: number;
}

// Heartbeat-writer seam. Implementations persist the heartbeat;
// this loop only emits it on cadence. A throwing writer must not
// stop the loop: failures are logged and the next tick retries.
export interface IndexHeartbeatWriter {
  writeHeartbeat(heartbeat: IndexHeartbeat): Promise<void>;
}

// Minimal local query port. Sibling worker v3b-06b owns the real
// query implementation; the integrator unifies this shape with
// theirs. The worker passes the port through to the scanner and
// never calls it directly.
export interface IndexQueryPort {
  resolveVersion(path: string): Promise<number | null>;
}

// Summary of one scan run, reported by the scanner. Counts only:
// paths and file contents stay inside the scanner implementation.
export interface IndexScanSummary {
  filesScanned: number;
  rowsUpserted: number;
  rowsRemoved: number;
}

export interface IndexScanInput {
  // Query port passed through from the worker, or undefined when
  // no query implementation is wired yet. The scanner decides how
  // to degrade; the loop never invents index state.
  query: IndexQueryPort | undefined;
  // Aborted when stop() runs while a scan is in flight. The
  // scanner should stop early when signalled; the loop awaits the
  // scan either way.
  signal: AbortSignal;
}

// Minimal local scanner port. Sibling worker v3b-06a owns the
// real scanner implementation; the integrator unifies this shape
// with theirs.
export interface IndexScannerPort {
  scan(input: IndexScanInput): Promise<IndexScanSummary>;
}

export type IndexWorkerLogLevel = 'info' | 'warn' | 'error';

// Structured logger. The event is a stable machine-readable name;
// fields carry counts, durations, and reasons, never secrets or
// absolute paths.
export interface IndexWorkerLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

// Clock seam. Production uses real timers; tests inject a fake
// clock to prove debounce, single-flight, shutdown, and heartbeat
// cadence deterministically without waiting on wall time.
export interface IndexWorkerClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realIndexWorkerClock: IndexWorkerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

function logLine(level: IndexWorkerLogLevel, event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields });
}

// Default logger: one JSON object per line, info/warn on stdout,
// errors on stderr. No values are redacted here because the loop
// never logs a value that needs redaction; keep it that way.
export function createConsoleIndexWorkerLogger(): IndexWorkerLogger {
  return {
    info: (event, fields = {}) => {
      process.stdout.write(`${logLine('info', event, fields)}\n`);
    },
    warn: (event, fields = {}) => {
      process.stdout.write(`${logLine('warn', event, fields)}\n`);
    },
    error: (event, fields = {}) => {
      process.stderr.write(`${logLine('error', event, fields)}\n`);
    },
  };
}

export interface IndexWorkerDeps {
  scanner: IndexScannerPort;
  query?: IndexQueryPort;
  // Absent until wave 5 wires the real writer. Absence is logged
  // honestly at start; it never produces a fake heartbeat.
  heartbeatWriter?: IndexHeartbeatWriter;
  logger?: IndexWorkerLogger;
  clock?: IndexWorkerClock;
}

export interface IndexWorkerOptions {
  scanIntervalMs?: number;
  scanDebounceMs?: number;
  heartbeatIntervalMs?: number;
  // Run one scan shortly after start (debounced like any other
  // request) so the index is reconciled without waiting for the
  // first periodic tick. Defaults to true.
  scanOnStart?: boolean;
  // Identity carried on every heartbeat. Defaults to
  // `index-worker-<pid>`.
  workerId?: string;
}

export type IndexWorkerState = 'created' | 'running' | 'stopping' | 'stopped';

export interface IndexWorkerStatus {
  state: IndexWorkerState;
  scanning: boolean;
  pendingScan: boolean;
  scansStarted: number;
  scansCompleted: number;
  scansFailed: number;
  lastScanAtMs: number | null;
  lastScanSummary: IndexScanSummary | null;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer number of milliseconds`);
  }
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of milliseconds`);
  }
}

function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message };
  }
  return { errorName: 'UnknownError', errorMessage: String(error) };
}

export class IndexWorker {
  private readonly scanner: IndexScannerPort;
  private readonly query: IndexQueryPort | undefined;
  private readonly heartbeatWriter: IndexHeartbeatWriter | undefined;
  private readonly logger: IndexWorkerLogger;
  private readonly clock: IndexWorkerClock;
  private readonly scanIntervalMs: number;
  private readonly scanDebounceMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly scanOnStart: boolean;
  private readonly workerId: string;

  private state: IndexWorkerState = 'created';
  private scanning = false;
  private pendingScan = false;
  private pendingReason = 'manual';
  private scansStarted = 0;
  private scansCompleted = 0;
  private scansFailed = 0;
  private lastScanAtMs: number | null = null;
  private lastScanSummary: IndexScanSummary | null = null;

  private periodicHandle: unknown = undefined;
  private debounceHandle: unknown = undefined;
  private heartbeatHandle: unknown = undefined;
  private scanAbort: AbortController | undefined;
  private scanPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(deps: IndexWorkerDeps, options: IndexWorkerOptions = {}) {
    if (deps.scanner === undefined || deps.scanner === null) {
      throw new TypeError('IndexWorker requires a scanner port');
    }
    this.scanner = deps.scanner;
    this.query = deps.query;
    this.heartbeatWriter = deps.heartbeatWriter;
    this.logger = deps.logger ?? createConsoleIndexWorkerLogger();
    this.clock = deps.clock ?? realIndexWorkerClock;
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.scanDebounceMs = options.scanDebounceMs ?? DEFAULT_SCAN_DEBOUNCE_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.scanOnStart = options.scanOnStart ?? true;
    this.workerId = options.workerId ?? `index-worker-${process.pid}`;
    requirePositiveInteger('scanIntervalMs', this.scanIntervalMs);
    requireNonNegativeInteger('scanDebounceMs', this.scanDebounceMs);
    requirePositiveInteger('heartbeatIntervalMs', this.heartbeatIntervalMs);
  }

  status(): IndexWorkerStatus {
    return {
      state: this.state,
      scanning: this.scanning,
      pendingScan: this.pendingScan,
      scansStarted: this.scansStarted,
      scansCompleted: this.scansCompleted,
      scansFailed: this.scansFailed,
      lastScanAtMs: this.lastScanAtMs,
      lastScanSummary: this.lastScanSummary,
    };
  }

  // Starts the loop. Idempotent while running: a second start
  // logs a warning and changes nothing, so double wiring cannot
  // create duplicate timers. A worker that has stopped cannot be
  // restarted; the host creates a new worker instead.
  start(): void {
    if (this.state === 'running') {
      this.logger.warn('index_worker_already_started', { workerId: this.workerId });
      return;
    }
    if (this.state === 'stopping' || this.state === 'stopped') {
      throw new Error('IndexWorker cannot be restarted after stop');
    }
    this.state = 'running';
    this.logger.info('index_worker_started', {
      workerId: this.workerId,
      scanIntervalMs: this.scanIntervalMs,
      scanDebounceMs: this.scanDebounceMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatWriterWired: this.heartbeatWriter !== undefined,
    });
    if (this.heartbeatWriter === undefined) {
      this.logger.warn('index_worker_no_heartbeat_writer', {
        workerId: this.workerId,
        detail: 'heartbeat seam unwired; wave 5 writer not yet installed',
      });
    } else {
      // Immediate first heartbeat, then the interval chain. The
      // write is fire-and-forget: start() must not block on the
      // heartbeat store, and a failed first write must not prevent
      // scans from running.
      void this.writeHeartbeat();
      this.scheduleHeartbeat();
    }
    this.schedulePeriodic();
    if (this.scanOnStart) {
      this.requestScan('startup');
    }
  }

  // Requests a scan. Requests are debounced: rapid calls collapse
  // into one scan after a quiet window of scanDebounceMs. A
  // request that arrives while a scan runs is remembered as one
  // pending follow-up scan, never as a second concurrent scan.
  // Requests after stop are ignored and logged.
  requestScan(reason = 'manual'): void {
    if (this.state !== 'running') {
      this.logger.warn('index_worker_scan_request_ignored', {
        workerId: this.workerId,
        reason,
        state: this.state,
      });
      return;
    }
    this.pendingReason = reason;
    if (this.debounceHandle !== undefined) {
      this.clock.clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = this.clock.setTimeout(() => {
      this.debounceHandle = undefined;
      this.onDebounceElapsed(reason);
    }, this.scanDebounceMs);
  }

  // Graceful shutdown. Stops all timers, aborts the in-flight
  // scan (if any) via its AbortSignal, and waits for that scan to
  // settle before resolving. A scan that ignores the abort signal
  // is still awaited: this method never abandons a scan
  // mid-transaction. The host process kill grace period, not this
  // method, bounds a scanner that never returns. Idempotent: all
  // callers await the same shutdown.
  stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }
    this.stopPromise = this.shutdown();
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }
    const wasRunning = this.state === 'running';
    this.state = 'stopping';
    this.clearTimer('periodic');
    this.clearTimer('debounce');
    this.clearTimer('heartbeat');
    this.pendingScan = false;
    if (this.scanAbort !== undefined) {
      this.scanAbort.abort();
    }
    if (this.scanPromise !== null) {
      await this.scanPromise;
    }
    this.state = 'stopped';
    if (wasRunning) {
      this.logger.info('index_worker_stopped', {
        workerId: this.workerId,
        scansStarted: this.scansStarted,
        scansCompleted: this.scansCompleted,
        scansFailed: this.scansFailed,
      });
    }
  }

  private clearTimer(which: 'periodic' | 'debounce' | 'heartbeat'): void {
    if (which === 'periodic' && this.periodicHandle !== undefined) {
      this.clock.clearTimeout(this.periodicHandle);
      this.periodicHandle = undefined;
    }
    if (which === 'debounce' && this.debounceHandle !== undefined) {
      this.clock.clearTimeout(this.debounceHandle);
      this.debounceHandle = undefined;
    }
    if (which === 'heartbeat' && this.heartbeatHandle !== undefined) {
      this.clock.clearTimeout(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }
  }

  private schedulePeriodic(): void {
    this.periodicHandle = this.clock.setTimeout(() => {
      this.periodicHandle = undefined;
      if (this.state !== 'running') {
        return;
      }
      // Reschedule first so the cadence survives a long scan: the
      // next tick is anchored to this tick, not to scan completion.
      this.schedulePeriodic();
      this.requestScan('periodic');
    }, this.scanIntervalMs);
  }

  private scheduleHeartbeat(): void {
    this.heartbeatHandle = this.clock.setTimeout(() => {
      this.heartbeatHandle = undefined;
      if (this.state !== 'running') {
        return;
      }
      this.scheduleHeartbeat();
      void this.writeHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private async writeHeartbeat(): Promise<void> {
    if (this.heartbeatWriter === undefined) {
      return;
    }
    const heartbeat: IndexHeartbeat = {
      workerId: this.workerId,
      atMs: this.clock.now(),
      scansStarted: this.scansStarted,
    };
    try {
      await this.heartbeatWriter.writeHeartbeat(heartbeat);
      this.logger.info('index_worker_heartbeat', {
        workerId: this.workerId,
        atMs: heartbeat.atMs,
        scansStarted: heartbeat.scansStarted,
      });
    } catch (error) {
      // A failed heartbeat must never stop scans or crash the
      // loop. The next tick retries; the ready check reports
      // staleness honestly if failures persist.
      this.logger.error('index_worker_heartbeat_failed', {
        workerId: this.workerId,
        ...errorFields(error),
      });
    }
  }

  private onDebounceElapsed(reason: string): void {
    if (this.state !== 'running') {
      return;
    }
    if (this.scanning) {
      // Single-flight: remember exactly one follow-up scan. The
      // follow-up is scheduled when the running scan settles.
      this.pendingScan = true;
      this.pendingReason = reason;
      return;
    }
    this.scanPromise = this.runScan(reason);
  }

  private async runScan(reason: string): Promise<void> {
    this.scanning = true;
    this.scansStarted += 1;
    const scanNumber = this.scansStarted;
    const startedAtMs = this.clock.now();
    const abort = new AbortController();
    this.scanAbort = abort;
    this.logger.info('index_scan_started', { workerId: this.workerId, reason, scanNumber });
    try {
      const summary = await this.scanner.scan({ query: this.query, signal: abort.signal });
      const durationMs = this.clock.now() - startedAtMs;
      this.scansCompleted += 1;
      this.lastScanAtMs = this.clock.now();
      this.lastScanSummary = summary;
      this.logger.info('index_scan_completed', {
        workerId: this.workerId,
        reason,
        scanNumber,
        durationMs,
        filesScanned: summary.filesScanned,
        rowsUpserted: summary.rowsUpserted,
        rowsRemoved: summary.rowsRemoved,
      });
    } catch (error) {
      this.scansFailed += 1;
      if (abort.signal.aborted) {
        this.logger.warn('index_scan_aborted', {
          workerId: this.workerId,
          reason,
          scanNumber,
          ...errorFields(error),
        });
      } else {
        // A failed scan must never crash the loop or stop future
        // scans: log it and keep the periodic cadence running.
        this.logger.error('index_scan_failed', {
          workerId: this.workerId,
          reason,
          scanNumber,
          ...errorFields(error),
        });
      }
    } finally {
      this.scanning = false;
      if (this.scanAbort === abort) {
        this.scanAbort = undefined;
      }
      // One pending follow-up scan at most. It goes through the
      // debounce window again, so a burst that arrived during the
      // scan still collapses into a single follow-up.
      if (this.pendingScan && this.state === 'running') {
        this.pendingScan = false;
        this.requestScan(this.pendingReason);
      }
    }
  }
}
