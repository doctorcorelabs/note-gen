// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError } from "../errors";
import type { OsAdapter, OsArch, OsPlatform } from "./interface";

/**
 * Web implementation of OsAdapter.
 *
 * - `platform()` always returns `"web"`, per the registry shim design
 *   (section 1.8). The value is new on purpose: it forces the G4 audit
 *   of every `platform()` call site instead of letting web runs
 *   silently take a desktop branch. The OS the browser happens to run
 *   on is NOT reported here; deriving a desktop platform value from
 *   the user agent would defeat the audit and mislead branches that
 *   assume desktop capabilities (shell paths, native sync, export).
 *   Code that needs to know whether it runs in a browser must use the
 *   runtime detection in detect.ts, not `platform()`.
 * - `version()` and `arch()` throw PlatformCapabilityError. Browsers
 *   expose OS version and CPU architecture only through the
 *   asynchronous high-entropy userAgentData API, which a synchronous
 *   function cannot call, and the OsArch type has no "unknown" member
 *   to return. Returning a guessed value would silently mislead
 *   diagnostics, so the failure is explicit. Both existing call sites
 *   (developer diagnostics, error recovery) already wrap these calls
 *   in try/catch and degrade to 'unknown', so the throw is safe.
 * - `locale()` returns `navigator.language`, or null when no navigator
 *   is available (server render) or the language string is empty.
 * - `getAppVersion()` returns a build constant. The value is the
 *   upstream base version from src-tauri/tauri.conf.json, which is the
 *   same value the desktop shell reports today. AD-03 names
 *   package.json as the source of truth for the fork version scheme
 *   `<upstream>-fork.<n>`, but package.json still carries the upstream
 *   placeholder 0.1.0, so no fork version exists to read yet. This
 *   constant must move to the package.json fork version once the
 *   owning worker updates package.json; this adapter must not change
 *   package.json itself.
 */

/** Upstream base version; see the getAppVersion note above. */
const FORK_APP_VERSION = "0.39.2";

export interface WebOsAdapterOptions {
  /**
   * Language tag reported by `locale()`. When the key is absent, the
   * global navigator language is read at factory time. Pass null to
   * simulate an environment without a navigator (server render), or
   * an explicit tag to pin the value. Test-only in practice;
   * production code calls the factory with no arguments.
   */
  readonly language?: string | null;
  /** Override for the reported app version. Test-only in practice. */
  readonly appVersion?: string;
}

function readNavigatorLanguage(): string | null {
  const nav = (globalThis as { navigator?: { language?: unknown } }).navigator;
  const language = typeof nav?.language === "string" ? nav.language : null;
  return language ? language : null;
}

export function createWebOsAdapter(options?: WebOsAdapterOptions): OsAdapter {
  let language: string | null;
  if (options !== undefined && "language" in options) {
    language = options.language ? options.language : null;
  } else {
    language = readNavigatorLanguage();
  }
  const appVersion = options?.appVersion ?? FORK_APP_VERSION;

  return {
    platform(): OsPlatform | "web" {
      return "web";
    },

    version(): string {
      throw capabilityError(
        "unavailable",
        "os",
        "os.version",
        "web",
        "The operating system version is not available through a synchronous browser API",
      );
    },

    arch(): OsArch {
      throw capabilityError(
        "unavailable",
        "os",
        "os.arch",
        "web",
        "The operating system CPU architecture is not available through a synchronous browser API",
      );
    },

    async locale(): Promise<string | null> {
      return language;
    },

    async getAppVersion(): Promise<string> {
      return appVersion;
    },
  };
}
