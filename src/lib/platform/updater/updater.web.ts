// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError } from "../errors";
import type { UpdaterAdapter, UpdaterUpdate } from "./interface";

/**
 * Disabled update handle. Every method rejects with a
 * PlatformCapabilityError (code `unsupported`); only the read-only
 * metadata properties are readable.
 *
 * This factory is unreachable through `check` in the web build, because
 * `check` always rejects. It exists so that no code path can ever hold a
 * live update handle that downloads or installs, and so tests can prove
 * that every handle method rejects with a typed error.
 */
export function createDisabledUpdaterUpdate(
  version: string,
  currentVersion: string,
  date?: string,
  body?: string,
): UpdaterUpdate {
  return {
    version,
    currentVersion,
    date,
    body,
    async download(): Promise<void> {
      throw capabilityError(
        "unsupported",
        "updater",
        "download",
        "web",
        "Downloading an application update is not available in the web build",
      );
    },
    async install(): Promise<void> {
      throw capabilityError(
        "unsupported",
        "updater",
        "install",
        "web",
        "Installing an application update is not available in the web build",
      );
    },
    async downloadAndInstall(): Promise<void> {
      throw capabilityError(
        "unsupported",
        "updater",
        "downloadAndInstall",
        "web",
        "Downloading and installing an application update is not available in the web build",
      );
    },
    async close(): Promise<void> {
      throw capabilityError(
        "unsupported",
        "updater",
        "close",
        "web",
        "Releasing an application update handle is not available in the web build",
      );
    },
  };
}

/**
 * Disabled web implementation of the updater adapter.
 *
 * `check` rejects with a PlatformCapabilityError (code `unsupported`).
 * This deliberately differs from the no-op behavior sketched in
 * desain-registry-shim.md section 1.14: the binding brief for this
 * worker requires every disabled method to fail explicitly. The update
 * UI must be hidden in web mode using the `isDisabled` flag; that wiring
 * is owned by the wave 3 codemod. No request is ever made to an update
 * manifest or release endpoint from this adapter.
 *
 * The factory takes no arguments and performs no I/O. Method parameters
 * are intentionally omitted from the implementation: a disabled adapter
 * never inspects them. The declared return type keeps the object
 * assignable to UpdaterAdapter, so a signature drift fails typecheck.
 *
 * Proposed user-facing message keys (not wired here; message catalogs are
 * owned by the integrator): `platform.updater.checkUnavailable`,
 * `platform.updater.downloadUnavailable`,
 * `platform.updater.installUnavailable`,
 * `platform.updater.downloadAndInstallUnavailable`,
 * `platform.updater.closeUnavailable`, `platform.updater.webNotice`.
 */
export function createWebUpdaterAdapter(): UpdaterAdapter {
  return {
    isDisabled: true,
    async check(): Promise<UpdaterUpdate | null> {
      throw capabilityError(
        "unsupported",
        "updater",
        "check",
        "web",
        "Checking for application updates is not available in the web build. Updates are deployed on the server.",
      );
    },
  };
}
