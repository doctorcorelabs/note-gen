// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * DialogAdapter interface (migration wave G3).
 *
 * Replaces the upstream plugin-dialog surface: open, save, confirm, ask,
 * message. The open/save signatures mirror the installed upstream
 * declarations (plugin-dialog 2.x), including the generic conditional
 * return type of open and the string-or-options second argument of
 * message, ask, and confirm.
 *
 * Merge M10 reconciliation (audit V2-40, decision D-01 approved by the
 * coordinator): the G0 path-shaped open/save stay canonical, and the
 * web-necessary additions from V2-12 join them: openFiles (content-
 * shaped picks, because a browser has no OS paths to return),
 * saveBlob (one-step write), prompt (fork addition: the centralized
 * in-app dialog module needs one text-input primitive), the
 * DialogService seam the web adapter delegates to, and the DialogKind,
 * DialogPickedFile, DialogOpenResult, DialogSaveTarget,
 * PromptDialogOptions, and DialogWebAdapterOptions types.
 *
 * Web semantics, binding: the web implementation rejects the
 * path-shaped open/save with an explicit unsupported error pointing
 * at openFiles/saveBlob. A bare file name must never cross the
 * adapter boundary as if it were an OS path. No function in this
 * module may fall back to window.confirm, window.alert, or
 * window.prompt: a missing dialog service is an explicit
 * PlatformCapabilityError, never a silent native popup.
 */


/** Extension filter for the file dialog, mirroring the Tauri plugin shape. */
export interface DialogFilter {
  /** Filter name shown to the user. */
  name: string;
  /** Extensions to filter, without a leading dot. */
  extensions: string[];
}

/** Options for the open dialog, mirroring the Tauri plugin shape. */
export interface OpenDialogOptions {
  /** Dialog title. Ignored by the browser file picker. */
  title?: string;
  /** Extension filters. Mapped to the picker `accept` list. */
  filters?: DialogFilter[];
  /**
   * Initial directory or file path on desktop. On the web only the file name
   * part is meaningful, and only as a hint; browsers do not accept a
   * starting directory for the file picker.
   */
  defaultPath?: string;
  /** Whether multiple selection is allowed. */
  multiple?: boolean;
  /** Whether the dialog selects a directory instead of files. */
  directory?: boolean;
  /** Desktop only. Ignored on the web. */
  recursive?: boolean;
  /** macOS only. Ignored on the web. */
  canCreateDirectories?: boolean;
}

/** Options for the save dialog, mirroring the Tauri plugin shape. */
export interface SaveDialogOptions {
  /** Dialog title. Ignored by the browser save flow. */
  title?: string;
  /** Extension filters. Used to build the save picker type list. */
  filters?: DialogFilter[];
  /** Suggested file name. Directory parts are stripped on the web. */
  defaultPath?: string;
  /** macOS only. Ignored on the web. */
  canCreateDirectories?: boolean;
}

/** Severity of a message or confirm dialog. */
export type DialogKind = "info" | "warning" | "error";

/** Options for a message dialog. */
export interface MessageDialogOptions {
  /** Dialog title. Defaults to the app name when omitted. */
  title?: string;
  /** Dialog kind. Defaults to `info`. */
  kind?: DialogKind;
  /** Label of the dismiss button. */
  okLabel?: string;
}

/** Options for a confirm/ask dialog. */
export interface ConfirmDialogOptions {
  /** Dialog title. Defaults to the app name when omitted. */
  title?: string;
  /** Dialog kind. Defaults to `info`. */
  kind?: DialogKind;
  /** Label of the confirm button. */
  okLabel?: string;
  /** Label of the cancel button. */
  cancelLabel?: string;
}

/** Options for a text prompt dialog (fork addition, no Tauri equivalent). */
export interface PromptDialogOptions {
  /** Dialog title. Defaults to the app name when omitted. */
  title?: string;
  /** Initial value of the text input. */
  defaultValue?: string;
  /** Placeholder text for the text input. */
  placeholder?: string;
  /** Label of the confirm button. */
  okLabel?: string;
  /** Label of the cancel button. */
  cancelLabel?: string;
  /** Label shown above the text input. */
  inputLabel?: string;
}

/**
 * One file picked by the user in the browser.
 *
 * `relativePath` is the path relative to the picked directory for directory
 * picks, and the file name for single file picks. `handle` is present only
 * when the File System Access API supplied the file; the hidden input
 * fallback has no handles. Callers must read content from `file`, never
 * from `name` or `relativePath` as if it were an OS path.
 */
export interface DialogPickedFile {
  /** File name without any directory part. */
  name: string;
  /** Path relative to the picked directory, or the file name. */
  relativePath: string;
  /** File size in bytes, as reported by the browser. */
  size: number;
  /** MIME type reported by the browser, possibly empty. */
  type: string;
  /** The picked file content. */
  file: File;
  /** File System Access handle, when the picker supplied one. */
  handle?: FileSystemFileHandle;
}

/**
 * Result of `DialogAdapter.open`: one picked file, several picked files, or
 * `null` when the user cancels. Callers narrow with `Array.isArray`.
 */
export type DialogOpenResult = DialogPickedFile | DialogPickedFile[] | null;

/**
 * Target chosen by `DialogAdapter.save`.
 *
 * `handle` is always set by the web implementation: `save` throws a
 * `PlatformCapabilityError` when the File System Access save picker is
 * unavailable, instead of returning a name-only target the user never
 * picked. The field stays optional so a path-based desktop target can
 * omit it. Callers that must save without the picker use `saveBlob`,
 * which downloads the content through an anchor element.
 */
export interface DialogSaveTarget {
  /** Suggested file name, without any directory part. */
  name: string;
  /** File System Access handle, when the save picker supplied one. */
  handle?: FileSystemFileHandle;
}

/**
 * Minimal in-app dialog service.
 *
 * Implemented by the centralized dialog UI module (V2-10). The web dialog
 * adapter delegates confirm/ask/message/prompt to this service and never
 * renders UI itself. Method signatures mirror the Tauri plugin functions so
 * migrated call sites keep their shape; `prompt` is the one addition.
 */
export interface DialogService {
  /** Show a confirm dialog. Resolves true when the user confirms. */
  confirm(
    message: string,
    options?: string | ConfirmDialogOptions,
  ): Promise<boolean>;
  /** Show a yes/no question dialog. Resolves true when the user answers yes. */
  ask(
    message: string,
    options?: string | ConfirmDialogOptions,
  ): Promise<boolean>;
  /** Show a message dialog. Resolves when the user dismisses it. */
  message(
    message: string,
    options?: string | MessageDialogOptions,
  ): Promise<void>;
  /**
   * Show a text prompt dialog. Resolves to the entered text, or `null` when
   * the user cancels.
   */
  prompt(
    message: string,
    options?: string | PromptDialogOptions,
  ): Promise<string | null>;
}

export type OpenDialogReturn<T extends OpenDialogOptions> =
  T["directory"] extends true
    ? T["multiple"] extends true
      ? string[] | null
      : string | null
    : T["multiple"] extends true
      ? string[] | null
      : string | null;

/**
 * Dialog adapter interface.
 *
 * open and save keep the upstream path shapes; the Tauri
 * implementation is a thin wrapper over the plugin. openFiles and
 * saveBlob are the content-shaped web paths: openFiles returns
 * picked files carrying their content, and saveBlob picks a save
 * target and writes the blob in a single user gesture. confirm,
 * ask, message, and prompt delegate to the injected DialogService.
 */
export interface DialogAdapter {
  open<T extends OpenDialogOptions>(
    options?: T,
  ): Promise<OpenDialogReturn<T>>;
  /**
   * Open the file or directory picker and return picked files with
   * their content. Returns null on cancel. Fork addition: the only
   * content-shaped open; call sites that need file content must use
   * this and must never feed a web file name into the file adapter.
   */
  openFiles(options?: OpenDialogOptions): Promise<DialogOpenResult>;
  save(options?: SaveDialogOptions): Promise<string | null>;
  /**
   * Pick a save target and write the blob. Returns false when the user
   * cancels the save picker. Uses an anchor download when the File
   * System Access API is unavailable. Fork addition.
   */
  saveBlob(options: SaveDialogOptions, blob: Blob): Promise<boolean>;
  message(
    message: string,
    options?: string | MessageDialogOptions,
  ): Promise<void>;
  ask(
    message: string,
    options?: string | ConfirmDialogOptions,
  ): Promise<boolean>;
  confirm(
    message: string,
    options?: string | ConfirmDialogOptions,
  ): Promise<boolean>;
  /**
   * Text prompt dialog via the injected dialog service. Fork
   * addition: the Tauri plugin has no prompt function.
   */
  prompt(
    message: string,
    options?: string | PromptDialogOptions,
  ): Promise<string | null>;
}

/** Factory options for the web dialog adapter. */
export interface DialogWebAdapterOptions {
  /**
   * In-app dialog service used for confirm/ask/message/prompt. When omitted,
   * the adapter uses the module default set with `setDefaultDialogService`
   * (see `dialog.web.ts`). When neither is set, those methods throw a
   * `PlatformCapabilityError`.
   */
  dialogService?: DialogService;
}
