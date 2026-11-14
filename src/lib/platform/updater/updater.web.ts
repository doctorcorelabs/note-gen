// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError } from "../errors";
import type { UpdateInfo, UpdaterAdapter } from "./interface";

/**
 * Disabled update info. downloadAndInstall rejects with a
 * PlatformCapabilityError (code `unsupported`); only the read-only
 * metadata properties are readable. `available` is true because a
 * constructed handle exists only for an update that was found;
 * `rawJson` is empty because the web build never fetches a release
 * manifest.
 *
 * This factory is unreachable through `check` in the web build, because
 * `check` always rejects. It exists so that no code path can ever hold a
 * live update handle that downloads or installs, and so tests can prove
 * that downloadAndInstall rejects with a typed error. The download,
 * install, and close members of the V2-15 draft were discarded in the
 * M13 reconciliation: the canonical interface excludes them because they
 * have no call sites.
 */
export function createDisabledUpdateInfo(
  version: string,
  currentVersion: string,
  date?: string,
  body?: string,
): UpdateInfo {
  return {
    available: true,
    version,
    currentVersion,
    date,
    body,
    rawJson: {},
    async downloadAndInstall(): Promise<void> {
      throw capabilityError(
        "unsupported",
        "updater",
        "downloadAndInstall",
        "web",
        "Downloading and installing an application update is not available in the web build",
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
 * UI must treat the rejection as the disabled state; that wiring is
 * owned by the wave 3 codemod (the `isDisabled` flag of the V2-15 draft
 * was discarded in the M13 reconciliation). No request is ever made to
 * an update manifest or release endpoint from this adapter.
 *
 * The factory takes no arguments and performs no I/O. Method parameters
 * are intentionally omitted from the implementation: a disabled adapter
 * never inspects them. The declared return type keeps the object
 * assignable to UpdaterAdapter, so a signature drift fails typecheck.
 *
 * Proposed user-facing message keys (not wired here; message catalogs are
 * owned by the integrator): `platform.updater.checkUnavailable`,
 * `platform.updater.downloadAndInstallUnavailable`,
 * `platform.updater.webNotice`.
 */
export function createWebUpdaterAdapter(): UpdaterAdapter {
  return {
    async check(): Promise<UpdateInfo | null> {
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
