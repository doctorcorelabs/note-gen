// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError } from "../errors";
import type { ProcessAdapter } from "./interface";

/**
 * Disabled web implementation of the process adapter.
 *
 * Every method rejects with a PlatformCapabilityError (code `unsupported`).
 * This deliberately differs from the no-op and page reload behavior
 * sketched in desain-registry-shim.md section 1.14: the binding brief for
 * this worker requires every disabled method to fail explicitly, so a
 * caller can never mistake a rejected quit or relaunch for success. Any
 * page reload or UI fallback is the call site's decision, owned by the
 * wave 3 codemod, not a silent behavior of this adapter.
 *
 * The factory takes no arguments and performs no I/O. Method parameters
 * are intentionally omitted from the implementation: a disabled adapter
 * never inspects them. The declared return type keeps the object
 * assignable to ProcessAdapter, so a signature drift fails typecheck.
 *
 * Proposed user-facing message keys (not wired here; message catalogs are
 * owned by the integrator): `platform.process.exitUnavailable`,
 * `platform.process.relaunchUnavailable`.
 */
export function createWebProcessAdapter(): ProcessAdapter {
  return {
    async exit(): Promise<void> {
      throw capabilityError(
        "unsupported",
        "process",
        "exit",
        "web",
        "Quitting the application process is not available in the web build",
      );
    },
    async relaunch(): Promise<void> {
      throw capabilityError(
        "unsupported",
        "process",
        "relaunch",
        "web",
        "Relaunching the application process is not available in the web build",
      );
    },
  };
}
