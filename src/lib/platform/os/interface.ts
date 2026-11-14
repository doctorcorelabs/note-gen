// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local OsAdapter interface (provisional).
 *
 * The canonical interface is owned by worker V2-04; the integrator
 * reconciles this local definition with the canonical one. This file
 * exists so the web implementation in this directory can be written,
 * typechecked, and tested without waiting for that reconciliation.
 *
 * Surface, per the V1-05 inventory (design registry shim, section 1.8):
 * `platform`, `version`, `locale`, and `arch` from plugin-os, plus
 * `getAppVersion` folded in from api/app (the only name imported from
 * that specifier anywhere in src). The plugin-os function `type` has
 * zero imports in src and is deliberately NOT part of this interface.
 *
 * Shape notes:
 * - `platform`, `version`, and `arch` stay synchronous, matching the
 *   upstream plugin functions and their call sites, which compare the
 *   result inline (for example `platform() === 'macos'`). Making them
 *   async would rewrite every call site for no behavioral gain.
 * - `locale` and `getAppVersion` stay async, matching the upstream
 *   functions, which return promises.
 * - The web `platform()` value is derived from `navigator`, not from a
 *   hardcoded marker. Call sites that branch on macOS, Windows, iOS, or
 *   Android behavior (shortcuts, export, sync paths) keep working.
 *   Runtime detection (web vs desktop shell) must use detect.ts, never
 *   this method: a browser on macOS legitimately reports 'macos'.
 */
export type OsPlatform =
  | "linux"
  | "macos"
  | "ios"
  | "freebsd"
  | "dragonfly"
  | "netbsd"
  | "openbsd"
  | "solaris"
  | "android"
  | "windows";

export type OsArch =
  | "x86"
  | "x86_64"
  | "arm"
  | "aarch64"
  | "mips"
  | "mips64"
  | "powerpc"
  | "powerpc64"
  | "riscv64"
  | "s390x"
  | "sparc64";

export interface OsAdapter {
  /** Operating system platform, derived from navigator in web mode. */
  platform(): OsPlatform;
  /**
   * Operating system version string. The web implementation throws
   * PlatformCapabilityError: no synchronous browser API exposes it.
   */
  version(): string;
  /**
   * Operating system CPU architecture. The web implementation throws
   * PlatformCapabilityError: no synchronous browser API exposes it.
   */
  arch(): OsArch;
  /** BCP-47 locale tag, or null when it cannot be obtained. */
  locale(): Promise<string | null>;
  /** Application version string. */
  getAppVersion(): Promise<string>;
}
