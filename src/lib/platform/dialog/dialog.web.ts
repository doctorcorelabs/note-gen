// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web implementation of the dialog adapter.
 *
 * File picking uses the File System Access API when the browser provides
 * it, and falls back to a hidden `<input type="file">` (with the
 * `webkitdirectory` attribute for directory picks) otherwise. The fallback
 * is mandatory: the File System Access API is absent in Firefox and in
 * non-secure contexts. Saving uses `showSaveFilePicker` when available and
 * an anchor download otherwise.
 *
 * Confirm, ask, message and prompt never use `window.confirm`,
 * `window.alert` or `window.prompt`. They delegate to the `DialogService`
 * injected through the factory options or registered as the module default
 * with `setDefaultDialogService`. The centralized dialog host
 * (`WebDialogHost`) installs its host-backed service through
 * `installHostDialogService` on mount; until a host mounts, those
 * methods throw a `PlatformCapabilityError`.
 *
 * All browser globals are read at call time through `globalThis`, never
 * captured at module load, so unit tests can substitute mocks and so the
 * module is safe to import during server-side rendering (methods then fail
 * with an explicit capability error instead of a ReferenceError).
 */

import { capabilityError } from "../errors";
import {
  dialogFiltersToAccept,
  dialogFiltersToPickerTypes,
  suggestedFileName,
} from "./file-filters";
import type {
  ConfirmDialogOptions,
  DialogAdapter,
  DialogOpenResult,
  DialogPickedFile,
  DialogWebAdapterOptions,
  DialogService,
  MessageDialogOptions,
  OpenDialogOptions,
  OpenDialogReturn,
  PromptDialogOptions,
  SaveDialogOptions,
} from "./interface";

/** Maximum directory depth traversed for a directory pick. */
const MAX_DIRECTORY_DEPTH = 20;
/** Maximum number of files collected from one directory pick. */
const MAX_DIRECTORY_FILES = 2000;
/** Delay before revoking a download object URL, in milliseconds. */
const DOWNLOAD_URL_REVOKE_DELAY_MS = 1000;

/** Module default dialog service, registered by the V2-10 UI module. */
let defaultDialogService: DialogService | undefined;

/**
 * Register the in-app dialog service used when the adapter factory is
 * called without one. Called once by the centralized dialog UI module.
 */
export function setDefaultDialogService(
  service: DialogService | undefined,
): void {
  defaultDialogService = service;
}

/** Test-only reset for the module default dialog service. */
export function __resetDefaultDialogServiceForTests(): void {
  defaultDialogService = undefined;
}

/** Minimal structural shape of a File System Access file handle. */
interface PickerFileHandle {
  readonly kind: string;
  readonly name: string;
  getFile(): Promise<File>;
}

/** Minimal structural shape of a File System Access directory handle. */
interface PickerDirectoryHandle {
  readonly kind: string;
  readonly name: string;
  values(): AsyncIterable<PickerFileHandle | PickerDirectoryHandle>;
}

/** Minimal structural shape of a writable stream from a save handle. */
interface PickerWritableStream {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

/** Minimal structural shape of a File System Access save handle. */
interface PickerSaveHandle extends PickerFileHandle {
  createWritable(): Promise<PickerWritableStream>;
}

/** Picker functions as read from the browser globals. */
interface PickerFunctions {
  showOpenFilePicker?: (
    options?: Record<string, unknown>,
  ) => Promise<PickerFileHandle[]>;
  showSaveFilePicker?: (
    options?: Record<string, unknown>,
  ) => Promise<PickerSaveHandle>;
  showDirectoryPicker?: (
    options?: Record<string, unknown>,
  ) => Promise<PickerDirectoryHandle>;
}

function getGlobals(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function getDocument(): Document | undefined {
  const value = getGlobals()["document"];
  return value === undefined ? undefined : (value as Document);
}

function getPickers(): PickerFunctions {
  const globals = getGlobals();
  const windowValue = globals["window"];
  const windowRecord =
    windowValue !== null && typeof windowValue === "object"
      ? (windowValue as Record<string, unknown>)
      : undefined;
  const read = (name: string): unknown =>
    globals[name] ?? windowRecord?.[name];
  // Bind each picker to its host object: calling a Window method
  // detached from window throws TypeError "Illegal invocation"
  // in Chrome (UTANG-UJI-06). The host is the window record when
  // present, else the globals object the function was read from.
  const bind = (value: unknown): unknown =>
    typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(windowRecord ?? globals)
      : value;
  const pickers: PickerFunctions = {};
  const openPicker = read("showOpenFilePicker");
  if (typeof openPicker === "function") {
    pickers.showOpenFilePicker =
      bind(openPicker) as PickerFunctions["showOpenFilePicker"];
  }
  const savePicker = read("showSaveFilePicker");
  if (typeof savePicker === "function") {
    pickers.showSaveFilePicker =
      bind(savePicker) as PickerFunctions["showSaveFilePicker"];
  }
  const directoryPicker = read("showDirectoryPicker");
  if (typeof directoryPicker === "function") {
    pickers.showDirectoryPicker =
      bind(directoryPicker) as PickerFunctions["showDirectoryPicker"];
  }
  return pickers;
}

function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function toPickedFile(
  file: File,
  relativePath: string,
  handle?: FileSystemFileHandle,
): DialogPickedFile {
  return {
    name: file.name,
    relativePath,
    size: file.size,
    type: file.type,
    file,
    ...(handle ? { handle } : {}),
  };
}

function shapeOpenResult(
  picked: DialogPickedFile[],
  multiple: boolean,
): DialogOpenResult {
  if (picked.length === 0) {
    return null;
  }
  if (multiple) {
    return picked;
  }
  return picked[0];
}

async function pickFilesWithFileSystemAccess(
  options: OpenDialogOptions,
): Promise<DialogOpenResult> {
  const picker = getPickers().showOpenFilePicker;
  if (!picker) {
    throw capabilityError(
      "unavailable",
      "dialog",
      "openFiles",
      "web",
      "File System Access API is unavailable in this browser.",
    );
  }
  const types = dialogFiltersToPickerTypes(options.filters);
  let handles: PickerFileHandle[];
  try {
    handles = await picker({
      multiple: options.multiple ?? false,
      ...(types.length > 0 ? { types } : {}),
    });
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }
    // Non-abort picker failures (SecurityError after transient
    // activation is lost, Illegal invocation on unbound hosts)
    // fall back to the input element instead of failing the
    // whole pick (UTANG-UJI-06).
    return pickWithInput(options);
  }
  const picked: DialogPickedFile[] = [];
  for (const handle of handles) {
    const file = await handle.getFile();
    picked.push(
      toPickedFile(
        file,
        file.name,
        handle as unknown as FileSystemFileHandle,
      ),
    );
  }
  return shapeOpenResult(picked, options.multiple ?? false);
}

async function collectDirectoryFiles(
  handle: PickerDirectoryHandle,
  prefix: string,
  depth: number,
  collected: DialogPickedFile[],
): Promise<void> {
  if (depth > MAX_DIRECTORY_DEPTH) {
    throw new Error(
      `Directory pick exceeded the maximum depth of ${MAX_DIRECTORY_DEPTH}.`,
    );
  }
  for await (const entry of handle.values()) {
    if (collected.length >= MAX_DIRECTORY_FILES) {
      throw new Error(
        `Directory pick exceeded the maximum of ${MAX_DIRECTORY_FILES} files.`,
      );
    }
    const childPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.kind === "file") {
      const file = await (entry as PickerFileHandle).getFile();
      collected.push(
        toPickedFile(
          file,
          childPath,
          entry as unknown as FileSystemFileHandle,
        ),
      );
    } else if (entry.kind === "directory") {
      await collectDirectoryFiles(
        entry as PickerDirectoryHandle,
        childPath,
        depth + 1,
        collected,
      );
    }
  }
}

async function pickDirectoryWithFileSystemAccess(): Promise<DialogOpenResult> {
  const picker = getPickers().showDirectoryPicker;
  if (!picker) {
    throw capabilityError(
      "unavailable",
      "dialog",
      "openFiles",
      "web",
      "File System Access API is unavailable in this browser.",
    );
  }
  let handle: PickerDirectoryHandle;
  try {
    handle = await picker({ mode: "read" });
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }
    // Same non-abort fallback as the file picker (UTANG-UJI-06).
    return pickWithInput({ directory: true });
  }
  const collected: DialogPickedFile[] = [];
  await collectDirectoryFiles(handle, "", 0, collected);
  // A directory pick always yields the file list shape when files were
  // found; an empty directory resolves to null, matching cancel semantics.
  return collected.length === 0 ? null : collected;
}

function pickWithInput(
  options: OpenDialogOptions,
): Promise<DialogOpenResult> {
  const document = getDocument();
  if (!document) {
    return Promise.reject(
      capabilityError(
        "unavailable",
        "dialog",
        "openFiles",
        "web",
        "File picking requires a browser document.",
      ),
    );
  }
  return new Promise<DialogOpenResult>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple ?? false;
    const accept = dialogFiltersToAccept(options.filters);
    if (accept !== "") {
      input.accept = accept;
    }
    if (options.directory) {
      input.webkitdirectory = true;
    }
    input.style.display = "none";
    let settled = false;
    const cleanup = (): void => {
      input.remove();
    };
    const settle = (result: DialogOpenResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    input.addEventListener("change", () => {
      try {
        const files = input.files ? Array.from(input.files) : [];
        const picked = files.map((file) =>
          toPickedFile(file, file.webkitRelativePath || file.name),
        );
        // A directory pick always returns the full file list, even when
        // `multiple` is false: shaping it to a single file would silently
        // drop every file but the first. An empty directory resolves to
        // null, matching the File System Access directory pick.
        settle(
          options.directory
            ? picked.length === 0
              ? null
              : picked
            : shapeOpenResult(picked, options.multiple ?? false),
        );
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
    input.addEventListener("cancel", () => {
      settle(null);
    });
    const body = document.body;
    if (body) {
      body.appendChild(input);
    }
    input.click();
  });
}

function downloadBlobViaAnchor(
  document: Document,
  blob: Blob,
  filename: string,
): void {
  const urlCtor = getGlobals()["URL"] as
    | {
        createObjectURL?: (blob: Blob) => string;
        revokeObjectURL?: (url: string) => void;
      }
    | undefined;
  if (typeof urlCtor?.createObjectURL !== "function") {
    throw capabilityError(
      "unavailable",
      "dialog",
      "saveBlob",
      "web",
      "Download requires URL.createObjectURL, which is unavailable.",
    );
  }
  if (!document.body) {
    throw capabilityError(
      "unavailable",
      "dialog",
      "saveBlob",
      "web",
      "Download requires a document body to host the download anchor.",
    );
  }
  const objectUrl = urlCtor.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
  const revoke = urlCtor.revokeObjectURL;
  if (typeof revoke === "function") {
    setTimeout(() => {
      revoke(objectUrl);
    }, DOWNLOAD_URL_REVOKE_DELAY_MS);
  }
}

async function saveBlobWithFileSystemAccess(
  options: SaveDialogOptions,
  blob: Blob,
): Promise<boolean> {
  const picker = getPickers().showSaveFilePicker;
  if (!picker) {
    throw capabilityError(
      "unavailable",
      "dialog",
      "saveBlob",
      "web",
      "File System Access API is unavailable in this browser.",
    );
  }
  const types = dialogFiltersToPickerTypes(options.filters);
  let handle: PickerSaveHandle;
  try {
    handle = await picker({
      suggestedName: suggestedFileName(options.defaultPath),
      ...(types.length > 0 ? { types } : {}),
    });
  } catch (error) {
    if (isAbortError(error)) {
      return false;
    }
    throw error;
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
  return true;
}

/**
 * Create the web dialog adapter.
 *
 * The returned adapter reads browser globals at call time. Confirm, ask,
 * message and prompt use the factory-provided dialog service, falling back
 * to the module default registered with `setDefaultDialogService`.
 */
export function createWebDialogAdapter(
  options: DialogWebAdapterOptions = {},
): DialogAdapter {
  const requireService = (capability: string): DialogService => {
    const service = options.dialogService ?? defaultDialogService;
    if (!service) {
      throw capabilityError(
        "unavailable",
        "dialog",
        capability,
        "web",
        "No in-app dialog service is registered. The centralized dialog UI module provides it; native window dialogs are never used as a fallback.",
      );
    }
    return service;
  };

  return {
    async open<T extends OpenDialogOptions>(
      openOptions?: T,
    ): Promise<OpenDialogReturn<T>> {
      void openOptions;
      // Path-shaped open has no web meaning: a browser has no OS paths
      // to return, and a bare file name must never cross the adapter
      // boundary as if it were a path. Call sites that need file
      // content use openFiles (D-01).
      throw capabilityError(
        "unsupported",
        "dialog",
        "open",
        "web",
        "Path-shaped open is unsupported in web mode; use openFiles to pick files with their content.",
      );
    },

    async openFiles(openOptions?: OpenDialogOptions): Promise<DialogOpenResult> {
      const resolved: OpenDialogOptions = openOptions ?? {};
      const pickers = getPickers();
      if (resolved.directory) {
        if (pickers.showDirectoryPicker) {
          return pickDirectoryWithFileSystemAccess();
        }
        return pickWithInput(resolved);
      }
      if (pickers.showOpenFilePicker) {
        return pickFilesWithFileSystemAccess(resolved);
      }
      return pickWithInput(resolved);
    },

    async save(saveOptions?: SaveDialogOptions): Promise<string | null> {
      void saveOptions;
      // Path-shaped save has no web meaning: the picked target lives
      // on the user's disk, not in the workspace, so returning its
      // name would invite call sites to write to the server instead.
      // Call sites that need to save content use saveBlob (D-01).
      throw capabilityError(
        "unsupported",
        "dialog",
        "save",
        "web",
        "Path-shaped save is unsupported in web mode; use saveBlob to write content.",
      );
    },

    async saveBlob(
      saveOptions: SaveDialogOptions,
      blob: Blob,
    ): Promise<boolean> {
      if (getPickers().showSaveFilePicker) {
        return saveBlobWithFileSystemAccess(saveOptions, blob);
      }
      const document = getDocument();
      if (!document) {
        throw capabilityError(
          "unavailable",
          "dialog",
          "saveBlob",
          "web",
          "Saving requires a browser document for the download fallback.",
        );
      }
      downloadBlobViaAnchor(
        document,
        blob,
        suggestedFileName(saveOptions.defaultPath),
      );
      return true;
    },

    async confirm(
      message: string,
      confirmOptions?: string | ConfirmDialogOptions,
    ): Promise<boolean> {
      const service = requireService("confirm");
      return service.confirm(message, confirmOptions);
    },

    async ask(
      message: string,
      askOptions?: string | ConfirmDialogOptions,
    ): Promise<boolean> {
      const service = requireService("ask");
      return service.ask(message, askOptions);
    },

    async message(
      message: string,
      messageOptions?: string | MessageDialogOptions,
    ): Promise<void> {
      const service = requireService("message");
      await service.message(message, messageOptions);
    },

    async prompt(
      message: string,
      promptOptions?: string | PromptDialogOptions,
    ): Promise<string | null> {
      const service = requireService("prompt");
      return service.prompt(message, promptOptions);
    },
  };
}
