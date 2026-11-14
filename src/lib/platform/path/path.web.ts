// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Web PathAdapter: pure POSIX string operations. No Tauri imports, no
// network, no filesystem access.
//
// Behavior notes, all verified against the call sites that use
// `@tauri-apps/api/path` in the reference repo (53 files, 56 import
// lines per V1-05):
//
// - appDataDir/appConfigDir return virtual prefixes (see interface.ts).
//   Callers join them with workspace-relative segments; the FsAdapter
//   strips the prefix before any server request.
// - join/dirname/basename/normalize follow Rust `std::path` lexical
//   semantics as closely as plain string code allows: an absolute later
//   segment replaces earlier ones in join, dirname returns "" when there
//   is no parent component, and normalize resolves `.`/`..` lexically.
// - normalize does NOT resolve symbolic links and does NOT require the
//   path to exist. The Tauri implementation documents symlink resolution;
//   the browser cannot do that, and the only caller that depends on
//   normalize for containment checks (resolveAttachmentChildPath) only
//   needs lexical behavior plus a prefix comparison.
// - Drive-letter paths (for example `C:/notes/x.md`) are handled so that
//   persisted desktop-style strings keep their shape through these
//   functions. The FsAdapter still rejects OS-absolute paths that do not
//   start with a virtual prefix, so a drive-letter path can never address
//   server files by accident.

import {
  VIRTUAL_APP_CONFIG_DIR,
  VIRTUAL_APP_DATA_DIR,
  type PathAdapter,
} from "./interface";

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function isAbsoluteSegment(posixPath: string): boolean {
  return posixPath.startsWith("/") || /^[a-zA-Z]:\//.test(posixPath);
}

/**
 * Lexical normalization. Resolves `.` and `..` without touching any
 * filesystem. `..` segments that would escape an absolute root are
 * dropped; leading `..` segments of a relative path are preserved.
 */
function normalizeLexical(input: string): string {
  const posix = toPosix(input);
  let prefix = "";
  let body = posix;
  const drive = /^([a-zA-Z]:)(\/)?/.exec(posix);
  if (drive) {
    prefix = drive[2] ? `${drive[1]}/` : drive[1];
    body = posix.slice(prefix.length);
  } else if (posix.startsWith("/")) {
    prefix = "/";
    body = posix.slice(1);
  }
  const absolute = prefix === "/" || prefix.endsWith("/");
  const out: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!absolute) {
        out.push("..");
      }
      continue;
    }
    out.push(segment);
  }
  if (prefix.endsWith(":") && !prefix.endsWith("/")) {
    return prefix + out.join("/");
  }
  return prefix + out.join("/");
}

function dirnameOf(path: string): string {
  const stripped = toPosix(path).replace(/\/+$/, "");
  if (stripped === "" || /^[a-zA-Z]:$/.test(stripped)) {
    return "";
  }
  const idx = stripped.lastIndexOf("/");
  if (idx === -1) {
    return "";
  }
  if (idx === 0) {
    return "/";
  }
  const parent = stripped.slice(0, idx);
  if (/^[a-zA-Z]:$/.test(parent)) {
    return `${parent}/`;
  }
  return parent;
}

function basenameOf(path: string, ext?: string): string {
  const stripped = toPosix(path).replace(/\/+$/, "");
  if (stripped === "") {
    return "";
  }
  const idx = stripped.lastIndexOf("/");
  let name = idx === -1 ? stripped : stripped.slice(idx + 1);
  if (name === "" || /^[a-zA-Z]:$/.test(name)) {
    return "";
  }
  if (ext !== undefined && ext !== "") {
    const dotted = ext.startsWith(".") ? ext : `.${ext}`;
    if (name.endsWith(dotted) && name.length > dotted.length) {
      name = name.slice(0, -dotted.length);
    } else if (name.endsWith(ext) && name.length > ext.length) {
      name = name.slice(0, -ext.length);
    }
  }
  return name;
}

function joinOf(paths: string[]): string {
  let acc = "";
  for (const raw of paths) {
    const segment = toPosix(raw);
    if (segment === "") {
      continue;
    }
    if (isAbsoluteSegment(segment)) {
      acc = segment;
    } else if (acc === "") {
      acc = segment;
    } else {
      acc = `${acc.replace(/\/+$/, "")}/${segment}`;
    }
  }
  return normalizeLexical(acc);
}

export function createWebPathAdapter(): PathAdapter {
  return {
    async appDataDir(): Promise<string> {
      return VIRTUAL_APP_DATA_DIR;
    },
    async appConfigDir(): Promise<string> {
      return VIRTUAL_APP_CONFIG_DIR;
    },
    async join(...paths: string[]): Promise<string> {
      return joinOf(paths);
    },
    async dirname(path: string): Promise<string> {
      return dirnameOf(path);
    },
    async basename(path: string, ext?: string): Promise<string> {
      return basenameOf(path, ext);
    },
    async normalize(path: string): Promise<string> {
      return normalizeLexical(path);
    },
  };
}
