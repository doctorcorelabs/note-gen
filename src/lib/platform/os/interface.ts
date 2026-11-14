// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * OsAdapter interface (migration wave G4).
 *
 * Replaces the upstream plugin-os surface used by the codebase
 * (platform, version, locale, arch) plus getVersion from api/app, folded
 * in here as getAppVersion because application version is runtime
 * metadata like the OS version. Signatures mirror the installed upstream
 * declarations (plugin-os 2.x, api 2.11.1).
 *
 * Sync and async behavior mirrors upstream exactly: platform, version,
 * and arch are synchronous (they read values the shell injects at load),
 * while locale and getAppVersion are async. Making the synchronous
 * functions async would rewrite every sync call site, so the adapter
 * keeps upstream shapes instead of forcing async-first.
 *
 * platform returns the literal "web" in web mode. That value is part of
 * the return type on purpose: every platform call site must be audited
 * for it during G4. The type function is not imported anywhere and is
 * excluded, as are eol, family, exeExtension, and hostname.
 *
 * The upstream type names Platform and Arch are renamed OsPlatform and
 * OsArch here so the platform barrel stays unambiguous.
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
