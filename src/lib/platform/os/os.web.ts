// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError } from "../errors";
import type { OsAdapter, OsPlatform } from "./interface";

/**
 * Web implementation of OsAdapter.
 *
 * - `platform()` is derived from `navigator` (user agent string plus
 *   the legacy platform hint and touch-point count). This preserves the
 *   behavior call sites depend on: shortcut modifiers, macOS-only
 *   export branches, and iOS/Android sync branches keep working in a
 *   browser. It deliberately does NOT return a synthetic marker value:
 *   the V1-05 design suggested returning 'web' and auditing every call
 *   site, but the wave 2 assignment for this adapter specifies
 *   navigator-derived platform detection, and the synchronous plugin
 *   surface cannot express "web" without breaking those comparisons.
 *   Code that needs to know whether it runs in a browser must use the
 *   runtime detection in detect.ts, not `platform()`.
 * - `version()` and `arch()` throw PlatformCapabilityError. Browsers
 *   expose OS version and CPU architecture only through the
 *   asynchronous high-entropy userAgentData API, which a synchronous
 *   function cannot call. Returning a guessed value would silently
 *   mislead diagnostics, so the failure is explicit. Both existing
 *   call sites (developer diagnostics, error recovery) already wrap
 *   these calls in try/catch and degrade to 'unknown'.
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

/** Minimal navigator surface this adapter reads. Kept structural so tests can inject fakes. */
export interface WebOsNavigatorInput {
  readonly userAgent?: string;
  readonly language?: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
}

export interface WebOsAdapterOptions {
  /**
   * Navigator input to detect from. When the key is absent, the global
   * navigator is read. Pass null to simulate an environment without a
   * navigator (server render). Test-only in practice; production code
   * calls the factory with no arguments.
   */
  readonly navigator?: WebOsNavigatorInput | null;
  /** Override for the reported app version. Test-only in practice. */
  readonly appVersion?: string;
}

function readGlobalNavigator(): WebOsNavigatorInput | null {
  const nav = (globalThis as { navigator?: WebOsNavigatorInput }).navigator;
  if (!nav) {
    return null;
  }
  return {
    userAgent: nav.userAgent,
    language: nav.language,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
  };
}

function detectPlatform(input: WebOsNavigatorInput | null): OsPlatform {
  if (!input) {
    // No navigator (server render, bare Node). Fall back to the neutral
    // POSIX value so render paths that only special-case macOS,
    // Windows, iOS, or Android keep their default branch.
    return "linux";
  }
  const ua = (input.userAgent ?? "").toLowerCase();
  const hint = (input.platform ?? "").toLowerCase();
  const touchPoints = input.maxTouchPoints ?? 0;

  if (/iphone|ipad|ipod/.test(ua) || /^(iphone|ipad|ipod)/.test(hint)) {
    return "ios";
  }
  if (/android/.test(ua)) {
    return "android";
  }
  if (/windows/.test(ua) || hint.startsWith("win")) {
    return "windows";
  }
  if (/macintosh|mac os x/.test(ua) || hint.startsWith("mac")) {
    // iPadOS 13+ in desktop mode reports a Macintosh user agent. A
    // touchscreen with a Macintosh agent is an iPad; real Macs report
    // zero touch points in Safari.
    if (touchPoints > 1) {
      return "ios";
    }
    return "macos";
  }
  if (/linux/.test(ua) || hint.startsWith("linux")) {
    return "linux";
  }
  return "linux";
}

export function createWebOsAdapter(options?: WebOsAdapterOptions): OsAdapter {
  const hasNavigatorOption = options !== undefined && "navigator" in options;
  const input = hasNavigatorOption ? (options.navigator ?? null) : readGlobalNavigator();
  const appVersion = options?.appVersion ?? FORK_APP_VERSION;

  return {
    platform(): OsPlatform {
      return detectPlatform(input);
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

    arch(): never {
      throw capabilityError(
        "unavailable",
        "os",
        "os.arch",
        "web",
        "The operating system CPU architecture is not available through a synchronous browser API",
      );
    },

    async locale(): Promise<string | null> {
      const language = input?.language;
      return language ? language : null;
    },

    async getAppVersion(): Promise<string> {
      return appVersion;
    },
  };
}
