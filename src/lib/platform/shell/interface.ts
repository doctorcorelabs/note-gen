// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local interface definition for the shell adapter, following the V1-05
 * inventory (desain-registry-shim.md section 1.14). The canonical interface
 * is owned by V2-04; the integrator reconciles this local definition with
 * the canonical one. Do not treat this file as the canonical definition.
 *
 * Only `open` is part of the interface: it is the only surface from the
 * desktop shell plugin imported anywhere in `src/` at HEAD 4dcaa3f
 * (4 files, each importing `open` only). Process spawning surfaces from
 * the same plugin are deliberately excluded: no call site imports them,
 * and the web build must never expose a process spawning capability.
 */
export interface ShellAdapter {
  /**
   * Open a path or URL with the default desktop application.
   *
   * In the web build this always rejects with a PlatformCapabilityError
   * (code `unsupported`, capability `open`). Callers must use the browser
   * opener path or hide the action; see the audit report for the call
   * sites that still import the desktop plugin directly.
   */
  open(path: string, openWith?: string): Promise<void>;
}
