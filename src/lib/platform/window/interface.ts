// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * WindowAdapter interface (V2-13).
 *
 * Local interface definition for this adapter family, following the V1-05
 * inventory (desain-registry-shim.md section 1.11). V2-04 owns the canonical
 * interfaces; the integrator reconciles this definition with the canonical
 * one. Callers must use the adapter through the platform registry, never by
 * importing an implementation file directly.
 *
 * Upstream surface replaced: `getCurrentWindow`, `currentMonitor`,
 * `LogicalSize`, `PhysicalPosition` from `@tauri-apps/api/window`, and
 * `WebviewWindow`, `getAllWebviewWindows`, `getCurrentWebviewWindow` from
 * `@tauri-apps/api/webviewWindow`. Window methods used upstream: close,
 * show, hide, setFocus, setTitle, setAlwaysOnTop, isMaximized, setSize,
 * setPosition, startDragging, outerPosition, minimize, destroy.
 *
 * Web behavior (binding for this worker): explicit window controls are
 * disabled, except `document.title` and the DOM fullscreen API when it is
 * safe to use. Disabled controls throw `PlatformCapabilityError`; they never
 * fail silently. Opening a new browser tab is navigation, not a window
 * control, and is exposed separately as `openWindow`.
 */

export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowOpenOptions {
  /** App route or same-origin URL to open, for example `/editor-window`. */
  url: string;
  /** Stable label for the new window or tab, for example `editor-<id>`. */
  label: string;
  title?: string;
}

export type WindowCapability =
  | "close"
  | "show"
  | "hide"
  | "setFocus"
  | "setTitle"
  | "setAlwaysOnTop"
  | "isMaximized"
  | "setSize"
  | "setPosition"
  | "startDragging"
  | "outerPosition"
  | "minimize"
  | "destroy"
  | "fullscreen"
  | "openWindow";

export interface WindowHandle {
  readonly label: string;

  /** Web: sets `document.title` for the current tab. */
  setTitle(title: string): Promise<void>;
  close(): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
  setFocus(): Promise<void>;
  minimize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  setSize(size: WindowSize): Promise<void>;
  setPosition(position: WindowPosition): Promise<void>;
  setAlwaysOnTop(enabled: boolean): Promise<void>;
  startDragging(): Promise<void>;
  outerPosition(): Promise<WindowPosition>;
  destroy(): Promise<void>;
}

export interface WindowAdapter {
  /** Handle for the current window or tab. The label is `main` on the web. */
  getCurrent(): WindowHandle;

  /**
   * All known windows. On the web, browser tabs cannot be enumerated, so
   * this returns only the current tab handle.
   */
  getAll(): Promise<WindowHandle[]>;

  /**
   * Open a window. On the web this opens a new browser tab for an app route
   * and returns a handle limited to title, focus, and close. Returns null
   * when the browser blocks the new tab (popup blocker) or when there is no
   * browser window (server-side rendering).
   */
  openWindow(options: WindowOpenOptions): Promise<WindowHandle | null>;

  /** True when the current tab is in DOM fullscreen (web) or fullscreen (desktop). */
  isFullscreen(): Promise<boolean>;

  /**
   * Request fullscreen. Returns true when fullscreen was entered, false when
   * the Fullscreen API is unavailable or the request was rejected (for
   * example, because it was not triggered by a user gesture). Never throws
   * for a rejected request.
   */
  requestFullscreen(): Promise<boolean>;

  /** Exit fullscreen. Returns false when there was nothing to exit or the API is unavailable. */
  exitFullscreen(): Promise<boolean>;

  /** Whether a capability is available in the running mode. UI must use this to hide disabled controls. */
  isSupported(capability: WindowCapability): boolean;
}
