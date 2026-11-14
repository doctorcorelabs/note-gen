// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError } from "../errors";
import type { ShellAdapter } from "./interface";

/**
 * Disabled web implementation of the shell adapter.
 *
 * Every method rejects with a PlatformCapabilityError (code `unsupported`).
 * There is deliberately no server side fallback: opening through a
 * desktop shell has no safe equivalent in the web build, and a silent
 * no-op would let callers believe the action succeeded.
 *
 * The factory takes no arguments and performs no I/O. Method parameters
 * are intentionally omitted from the implementation: a disabled adapter
 * never inspects them. The declared return type keeps the object
 * assignable to ShellAdapter, so a signature drift fails typecheck.
 *
 * Proposed user-facing message key (not wired here; message catalogs are
 * owned by the integrator): `platform.shell.openUnavailable`.
 */
export function createWebShellAdapter(): ShellAdapter {
  return {
    async open(): Promise<void> {
      throw capabilityError(
        "unsupported",
        "shell",
        "open",
        "web",
        "Opening a path or URL through the desktop shell is not available in the web build",
      );
    },
  };
}
