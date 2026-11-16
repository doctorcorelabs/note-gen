// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Revision-guard conflict handling for the web editor (V1-09 section
 * 3.9, AD-17). When a guarded save meets HTTP 412 `revision_conflict`,
 * the editor must never overwrite silently and must never discard the
 * editor content. The user picks one of three choices, and only the
 * explicit force choice overwrites the server copy.
 *
 * This module is DOM-free and store-free on purpose: the article store
 * and the dialog component both use it, and the unit spec exercises
 * every choice against a fake filesystem adapter. Conflict detection
 * is structural (the canonical wire code plus the conflict payload
 * shape) because the platform barrel does not export the FsAdapterError
 * class; the web adapter guarantees both fields on 412/409 guard
 * failures, and the raw `version_conflict` code is accepted the same
 * way the adapter helper does.
 */

import type {
  BaseDirectory,
  FileInfo,
  FsTextFileResult,
  ReadFileOptions,
  StatOptions,
  WriteFileOptions,
} from "@/lib/platform";
import type { FsConflictPayload } from "@/lib/platform/fs/errors";

export type RevisionConflictChoice =
  | "reload"
  | "save-copy"
  | "force-overwrite";

/**
 * The choice highlighted by default in the dialog. Design 3.9 requires
 * the default to be reload or save-copy, never force-overwrite.
 */
export const DEFAULT_REVISION_CONFLICT_CHOICE: RevisionConflictChoice =
  "reload";

/** Serializable snapshot of one guard conflict, kept in the store. */
export interface RevisionConflictInfo {
  path: string;
  localContent: string;
  serverRevision: string;
  serverVersion: number | null;
  serverModifiedAt: string;
  serverSize: number;
  currentPreview: string | null;
  previewTruncated: boolean;
  suggestedCopyPath: string | null;
}

/** Store entry: the conflict plus whether the user dismissed the dialog. */
export interface RevisionConflictEntry extends RevisionConflictInfo {
  dismissed: boolean;
}

/** Path options in the shape `getFilePathOptions` returns. */
export interface RevisionConflictPathOptions {
  path: string;
  baseDir?: BaseDirectory;
}

/** Minimal filesystem surface the resolution flow needs. */
export interface RevisionConflictFs {
  readTextFileDetailed(
    path: string | URL,
    options?: ReadFileOptions,
  ): Promise<FsTextFileResult>;
  writeTextFile(
    path: string | URL,
    data: string,
    options?: WriteFileOptions,
  ): Promise<void>;
  stat(path: string | URL, options?: StatOptions): Promise<FileInfo>;
}

export type RevisionConflictResolution =
  | {
      choice: "reload";
      status: "reloaded";
      content: string;
      revision: string | null;
    }
  | {
      choice: "save-copy";
      status: "copied";
      copyPath: string;
      content: string;
      revision: string | null;
    }
  | {
      choice: "save-copy";
      status: "copy-exists";
      copyPath: string;
      suggestedCopyPath: string;
    }
  | {
      choice: "force-overwrite";
      status: "overwritten";
      revision: string | null;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * True for revision conflicts from either guard location: HTTP 412
 * `revision_conflict` (If-Match) or HTTP 409 `version_conflict`
 * (expectedRevision in a JSON body). Both must be treated the same way.
 */
export function isRevisionConflictLike(err: unknown): boolean {
  const record = asRecord(err);
  const code = record ? asString(record.code) : null;
  return code === "revision_conflict" || code === "version_conflict";
}

function isAlreadyExistsError(err: unknown): boolean {
  const record = asRecord(err);
  return record ? asString(record.code) === "already_exists" : false;
}

/**
 * Coerce the conflict payload carried on a guard error. Returns null
 * when the error carries no payload object; the dialog still works
 * with empty server details in that case.
 */
export function extractConflictPayload(
  err: unknown,
): FsConflictPayload | null {
  const record = asRecord(err);
  const raw = record ? asRecord(record.conflict) : null;
  if (!raw) {
    return null;
  }
  const serverRevision = asString(raw.serverRevision) ?? "";
  const serverVersion =
    typeof raw.serverVersion === "number" ? raw.serverVersion : null;
  const serverModifiedAt = asString(raw.serverModifiedAt) ?? "";
  const serverSize = typeof raw.serverSize === "number" ? raw.serverSize : 0;
  const currentPreview = asString(raw.currentPreview);
  const previewTruncated = raw.previewTruncated === true;
  const suggestedCopyPath = asString(raw.suggestedCopyPath);
  const actions = Array.isArray(raw.actions)
    ? raw.actions.filter(
        (action): action is string => typeof action === "string",
      )
    : [];
  return {
    path: asString(raw.path) ?? "",
    serverRevision,
    serverVersion,
    serverModifiedAt,
    serverSize,
    currentPreview,
    previewTruncated,
    suggestedCopyPath,
    actions,
  };
}

export function toRevisionConflictInfo(
  path: string,
  localContent: string,
  conflict: FsConflictPayload | null | undefined,
): RevisionConflictInfo {
  return {
    path,
    localContent,
    serverRevision: conflict?.serverRevision ?? "",
    serverVersion: conflict?.serverVersion ?? null,
    serverModifiedAt: conflict?.serverModifiedAt ?? "",
    serverSize: conflict?.serverSize ?? 0,
    currentPreview: conflict?.currentPreview ?? null,
    previewTruncated: conflict?.previewTruncated ?? false,
    suggestedCopyPath: conflict?.suggestedCopyPath ?? null,
  };
}

function splitName(path: string): {
  dir: string;
  stem: string;
  ext: string;
} {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return { dir, stem: base, ext: "" };
  }
  return { dir, stem: base.slice(0, dot), ext: base.slice(dot) };
}

function joinName(dir: string, base: string): string {
  return dir === "" ? base : `${dir}/${base}`;
}

/**
 * Copy target for the save-copy choice. The server suggestion wins when
 * it names a different path; otherwise a ` (copy)` suffix is inserted
 * before the extension. Never returns the original path.
 */
export function deriveCopyPath(
  path: string,
  suggestedCopyPath: string | null | undefined,
): string {
  const suggestion = suggestedCopyPath?.trim() ?? "";
  if (suggestion !== "" && suggestion !== path) {
    return suggestion;
  }
  const { dir, stem, ext } = splitName(path);
  return joinName(dir, `${stem} (copy)${ext}`);
}

/**
 * Next copy name after an `already_exists` answer for the attempted
 * copy path: `a (copy).md` becomes `a (copy 2).md`, then the counter
 * increments. Used only to suggest; the write itself stays guarded
 * with create-new semantics and never overwrites.
 */
export function nextCopyPath(copyPath: string): string {
  const { dir, stem, ext } = splitName(copyPath);
  const numbered = /^(.*) \(copy (\d+)\)$/.exec(stem);
  if (numbered) {
    const next = Number(numbered[2]) + 1;
    return joinName(dir, `${numbered[1]} (copy ${next})${ext}`);
  }
  if (stem.endsWith(" (copy)")) {
    return joinName(dir, `${stem.slice(0, -" (copy)".length)} (copy 2)${ext}`);
  }
  return deriveCopyPath(copyPath, null);
}

function readOptions(
  options: RevisionConflictPathOptions,
): ReadFileOptions | undefined {
  return options.baseDir === undefined
    ? undefined
    : { baseDir: options.baseDir };
}

function statOptions(
  options: RevisionConflictPathOptions,
): StatOptions | undefined {
  return options.baseDir === undefined
    ? undefined
    : { baseDir: options.baseDir };
}

function writeOptions(
  options: RevisionConflictPathOptions,
  extra: Pick<WriteFileOptions, "createNew" | "force">,
): WriteFileOptions | undefined {
  const merged: WriteFileOptions = { ...extra };
  if (options.baseDir !== undefined) {
    merged.baseDir = options.baseDir;
  }
  return merged;
}

async function readCurrentRevision(
  fs: RevisionConflictFs,
  options: RevisionConflictPathOptions,
): Promise<string | null> {
  try {
    const info = await fs.stat(options.path, statOptions(options));
    return info.revision ?? null;
  } catch {
    // The write already succeeded; an unreadable stat only means the
    // next save falls back to the adapter read-then-guard behavior.
    return null;
  }
}

/**
 * Carry out one explicit user choice. The only path that overwrites
 * the server copy is `force-overwrite`, and it requires the caller to
 * pass that exact choice.
 *
 * - reload: read the server copy; nothing is written.
 * - save-copy: create the copy with create-new semantics (a taken name
 *   answers `copy-exists` with the next suggestion instead of
 *   overwriting), then read the server copy so the editor can show it
 *   while the local content lives on in the copy.
 * - force-overwrite: rewrite the server copy with `force`, which the
 *   adapter sends as `If-Match: *`.
 *
 * Other errors propagate so the dialog can report them and stay open.
 */
export async function applyRevisionConflictChoice(
  fs: RevisionConflictFs,
  args: {
    choice: RevisionConflictChoice;
    sourceOptions: RevisionConflictPathOptions;
    copyOptions?: RevisionConflictPathOptions;
    copyPath?: string;
    localContent: string;
  },
): Promise<RevisionConflictResolution> {
  if (args.choice === "reload") {
    const current = await fs.readTextFileDetailed(
      args.sourceOptions.path,
      readOptions(args.sourceOptions),
    );
    return {
      choice: "reload",
      status: "reloaded",
      content: current.content,
      revision: current.revision,
    };
  }

  if (args.choice === "save-copy") {
    const copyPath = args.copyPath;
    const copyOptions = args.copyOptions;
    if (!copyPath || !copyOptions) {
      throw new Error("Save-copy choice requires a copy path");
    }
    try {
      await fs.writeTextFile(copyOptions.path, args.localContent, {
        ...writeOptions(copyOptions, { createNew: true }),
      });
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        return {
          choice: "save-copy",
          status: "copy-exists",
          copyPath,
          suggestedCopyPath: nextCopyPath(copyPath),
        };
      }
      throw err;
    }
    const current = await fs.readTextFileDetailed(
      args.sourceOptions.path,
      readOptions(args.sourceOptions),
    );
    return {
      choice: "save-copy",
      status: "copied",
      copyPath,
      content: current.content,
      revision: current.revision,
    };
  }

  await fs.writeTextFile(
    args.sourceOptions.path,
    args.localContent,
    writeOptions(args.sourceOptions, { force: true }),
  );
  return {
    choice: "force-overwrite",
    status: "overwritten",
    revision: await readCurrentRevision(fs, args.sourceOptions),
  };
}
