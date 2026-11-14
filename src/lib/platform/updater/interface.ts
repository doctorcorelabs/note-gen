// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * UpdaterAdapter interface (migration wave G5, lifecycle family).
 *
 * Replaces the upstream plugin-updater surface used by the codebase:
 * the check function and the Update object it returns. Only
 * src/stores/update.ts imports this module, guarded to desktop.
 * Signatures mirror the installed upstream declarations
 * (plugin-updater 2.x). The option and event type names carry an Update
 * prefix here (upstream: CheckOptions, DownloadOptions, DownloadEvent)
 * and the Update class becomes the UpdateInfo interface, so the platform
 * barrel stays unambiguous.
 *
 * Only the version field and downloadAndInstall have call sites. The
 * remaining data fields are included because the whole object is stored
 * in state; download, install, and close have no call sites and are
 * excluded.
 */
export interface UpdateCheckOptions {
  headers?: HeadersInit;
  timeout?: number;
  proxy?: string;
  target?: string;
  allowDowngrades?: boolean;
}

export interface UpdateDownloadOptions {
  headers?: HeadersInit;
  timeout?: number;
}

export type UpdateDownloadEvent =
  | {
      event: "Started";
      data: {
        contentLength?: number;
      };
    }
  | {
      event: "Progress";
      data: {
        chunkLength: number;
      };
    }
  | {
      event: "Finished";
    };

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
  downloadAndInstall(
    onEvent?: (progress: UpdateDownloadEvent) => void,
    options?: UpdateDownloadOptions,
  ): Promise<void>;
}

export interface UpdaterAdapter {
  check(options?: UpdateCheckOptions): Promise<UpdateInfo | null>;
}
