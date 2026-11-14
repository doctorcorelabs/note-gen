// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local OsAdapter interface (provisional copy of the canonical interface).
 *
 * The canonical interface is owned by worker V2-04 (branch
 * web-registry-g0). The type declarations below are identical to the
 * canonical ones read from that branch, so the integrator can keep
 * either copy with no type reconciliation. This copy exists so the
 * web implementation in this directory can be written, typechecked,
 * and tested inside this branch without waiting for the merge.
 *
 * Surface, per the V1-05 inventory (design registry shim, section
 * 1.8), re-verified against the reference tree at 4dcaa3f: `platform`,
 * `version`, `locale`, and `arch` from plugin-os, plus `getAppVersion`
 * folded in from api/app (the only name imported from that specifier
 * anywhere in src). The plugin-os function `type` has zero imports in
 * src and is deliberately NOT part of this interface; `eol`, `family`,
 * `exeExtension`, and `hostname` are likewise excluded as unused.
 *
 * Shape notes:
 * - `platform`, `version`, and `arch` stay synchronous, matching the
 *   upstream plugin functions and their call sites, which compare the
 *   result inline (for example `platform() === 'macos'`). Making them
 *   async would rewrite every call site for no behavioral gain.
 * - `locale` and `getAppVersion` stay async, matching the upstream
 *   functions, which return promises.
 * - `platform()` returns `OsPlatform | "web"`. The web implementation
 *   always returns `"web"`; every `platform()` call site must be
 *   audited for that value during wave G4 (design section 1.8, G4
 *   exit gate). Runtime detection (web vs desktop shell) must use
 *   detect.ts, never this method.
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
  platform(): OsPlatform | "web";
  version(): string;
  arch(): OsArch;
  locale(): Promise<string | null>;
  getAppVersion(): Promise<string>;
}
