// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Deep Search worker stub (F2-2, wave G-F2-2a).
//
// This wave ships schema + job API only. The stub exists so the
// registration adapter pins the wiring point now: starting it does
// nothing, and jobs stay queued. The real executor (Collector in
// G-F2-2b/c, Assessor + Complement in G-F2-2d, Writer in G-F2-2e)
// replaces this stub behind the same start/stop shape.
//
// Binding executor rules the later waves must honor (design 3.2):
// one background worker in the api process, oldest queued job per
// workspace, small concurrency (decision 6: 1 running job per
// workspace), explicit per-stage timeouts, stale running jobs
// marked failed with error_code worker_restarted at startup.

export interface DeepSearchWorkerHandle {
  stop: () => void;
}

export function startDeepSearchWorkerStub(): DeepSearchWorkerHandle {
  // Deliberately empty: no polling, no timers, no external calls.
  // Jobs created in this wave remain queued until the executor
  // waves land.
  return {
    stop: () => {
      // Nothing to stop.
    },
  };
}
