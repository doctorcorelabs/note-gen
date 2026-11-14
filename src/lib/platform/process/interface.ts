// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local interface definition for the process adapter, following the V1-05
 * inventory (desain-registry-shim.md section 1.14). The canonical interface
 * is owned by V2-04; the integrator reconciles this local definition with
 * the canonical one. Do not treat this file as the canonical definition.
 *
 * The interface covers exactly the two surfaces from the desktop process
 * plugin imported anywhere in `src/` at HEAD 4dcaa3f: `relaunch`
 * (4 files) and `exit` (1 file).
 */
export interface ProcessAdapter {
  /**
   * Exit the application process immediately with the given code.
   *
   * In the web build this always rejects with a PlatformCapabilityError
   * (code `unsupported`, capability `exit`). There is no process to quit
   * from a browser tab.
   */
  exit(code?: number): Promise<void>;

  /**
   * Exit the current application instance, then relaunch it.
   *
   * In the web build this always rejects with a PlatformCapabilityError
   * (code `unsupported`, capability `relaunch`). A page reload is a UI
   * decision for the call site, not a behavior of this adapter.
   */
  relaunch(): Promise<void>;
}
