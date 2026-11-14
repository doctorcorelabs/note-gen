// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local interface definition for the updater adapter, following the V1-05
 * inventory (desain-registry-shim.md section 1.14). The canonical interface
 * is owned by V2-04; the integrator reconciles this local definition with
 * the canonical one. Do not treat this file as the canonical definition.
 *
 * The interface covers the two surfaces from the desktop updater plugin
 * imported anywhere in `src/` at HEAD 4dcaa3f, both in one file
 * (`src/stores/update.ts`): `check` and the `Update` handle type.
 */

/**
 * Options accepted by `UpdaterAdapter.check`. This is the used subset
 * only: the single call site passes `timeout` and `target`. The full
 * plugin option set also carries headers, a proxy URL, and a downgrade
 * flag; those are excluded under the used-behavior rule and the
 * canonical interface owner (V2-04) decides whether they ever return.
 */
export interface UpdaterCheckOptions {
  timeout?: number;
  target?: string;
}

/** Progress events reported while an update package downloads. */
export type UpdaterDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** Options accepted by the update handle download methods. */
export interface UpdaterDownloadOptions {
  timeout?: number;
}

/**
 * Handle for one available update, mirroring the desktop plugin handle.
 *
 * Only `version` and `downloadAndInstall` are used in `src/` today
 * (`src/stores/update.ts` reads `version`;
 * `src/app/core/setting/about/updater.tsx` calls `downloadAndInstall`).
 * The remaining members are fail-closed guards: they exist so that no
 * code path holding an update handle can silently gain download, install,
 * or release behavior in the web build. The canonical interface owner
 * (V2-04) decides the final member subset.
 */
export interface UpdaterUpdate {
  readonly version: string;
  readonly currentVersion: string;
  readonly date?: string;
  readonly body?: string;
  download(
    onEvent?: (progress: UpdaterDownloadEvent) => void,
    options?: UpdaterDownloadOptions,
  ): Promise<void>;
  install(): Promise<void>;
  downloadAndInstall(
    onEvent?: (progress: UpdaterDownloadEvent) => void,
    options?: UpdaterDownloadOptions,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface UpdaterAdapter {
  /**
   * Gating flag for the UI: `true` in the web build, where the updater
   * is disabled and update UI must be hidden. Callers gate on this flag
   * instead of checking the runtime mode themselves.
   */
  readonly isDisabled: boolean;

  /**
   * Check for an available application update.
   *
   * In the web build this always rejects with a PlatformCapabilityError
   * (code `unsupported`, capability `check`). Updates in the web build
   * are server deployments, never an in-app download.
   */
  check(options?: UpdaterCheckOptions): Promise<UpdaterUpdate | null>;
}
