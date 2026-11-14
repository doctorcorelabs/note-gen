// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError } from "../errors";
import type { AutostartAdapter } from "./interface";

/**
 * Disabled web implementation of the autostart adapter.
 *
 * Every method rejects with a PlatformCapabilityError (code `unsupported`),
 * including `isEnabled`. This deliberately differs from the no-op behavior
 * sketched in desain-registry-shim.md section 1.14: the binding brief for
 * this worker requires every disabled method to fail explicitly. Hiding
 * the autostart setting in web mode is a UI decision for the call site,
 * owned by the wave 3 codemod; the existing call site already catches
 * these rejections and reports them through its own error paths.
 *
 * The factory takes no arguments and performs no I/O. The declared return
 * type keeps the object assignable to AutostartAdapter, so a signature
 * drift fails typecheck.
 *
 * Proposed user-facing message keys (not wired here; message catalogs are
 * owned by the integrator): `platform.autostart.isEnabledUnavailable`,
 * `platform.autostart.enableUnavailable`,
 * `platform.autostart.disableUnavailable`.
 */
export function createWebAutostartAdapter(): AutostartAdapter {
  return {
    async isEnabled(): Promise<boolean> {
      throw capabilityError(
        "unsupported",
        "autostart",
        "isEnabled",
        "web",
        "Reading the launch-at-startup setting is not available in the web build",
      );
    },
    async enable(): Promise<void> {
      throw capabilityError(
        "unsupported",
        "autostart",
        "enable",
        "web",
        "Enabling launch at startup is not available in the web build",
      );
    },
    async disable(): Promise<void> {
      throw capabilityError(
        "unsupported",
        "autostart",
        "disable",
        "web",
        "Disabling launch at startup is not available in the web build",
      );
    },
  };
}
