// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import type { EventCallback, EventName, UnlistenFn } from "../event/interface";

/**
 * WindowAdapter interface (migration wave G4).
 *
 * Replaces the upstream api/window and api/webviewWindow surfaces used
 * by the codebase. The correct specifier spelling is webviewWindow
 * (camelCase); no code imports an api/webview module. Signatures mirror
 * the installed upstream declarations (api 2.11.1).
 *
 * One WindowHandle covers both the Window and WebviewWindow shapes: every
 * method below is used on at least one handle obtained from
 * getCurrentWindow, getCurrentWebviewWindow, getAllWebviewWindows,
 * getByLabel, or a WebviewWindow construction. Methods with no
 * window-receiver call site (emit, scaleFactor, and the remaining Window
 * setters and queries) are excluded.
 *
 * Sizes and positions are plain structural values, not the upstream
 * LogicalSize and PhysicalPosition classes: a type-only interface cannot
 * provide constructors. The single construction site migrates to plain
 * objects ({ type: "Logical", width, height }) during G4, and the Tauri
 * implementation converts them to upstream classes internally. Upstream
 * class instances remain assignable to these structural types.
 *
 * The constructor of WebviewWindow becomes the createWebviewWindow
 * factory, and the getByLabel static becomes getWebviewWindowByLabel.
 * The options bag holds exactly the keys used at the 4 construction
 * sites. getAllWindows is not imported; the current-monitor query is
 * the only monitor function used.
 */
export interface LogicalSizeValue {
  readonly type: "Logical";
  width: number;
  height: number;
}

export interface PhysicalSizeValue {
  readonly type: "Physical";
  width: number;
  height: number;
}

export interface LogicalPositionValue {
  readonly type: "Logical";
  x: number;
  y: number;
}

export interface PhysicalPositionValue {
  readonly type: "Physical";
  x: number;
  y: number;
}

export type WindowSizeValue = LogicalSizeValue | PhysicalSizeValue;

export type WindowPositionValue = LogicalPositionValue | PhysicalPositionValue;

export type WindowTitleBarStyle = "visible" | "transparent" | "overlay";

export interface Monitor {
  name: string | null;
  size: PhysicalSizeValue;
  position: PhysicalPositionValue;
  workArea: {
    position: PhysicalPositionValue;
    size: PhysicalSizeValue;
  };
  scaleFactor: number;
}

export interface CloseRequestedEvent {
  event: EventName;
  id: number;
  preventDefault(): void;
  isPreventDefault(): boolean;
}

export interface WebviewWindowOptions {
  url?: string;
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  center?: boolean;
  visible?: boolean;
  resizable?: boolean;
  dragDropEnabled?: boolean;
  titleBarStyle?: WindowTitleBarStyle;
}

export interface WindowHandle {
  readonly label: string;
  listen<T>(
    event: EventName,
    handler: EventCallback<T>,
  ): Promise<UnlistenFn>;
  once<T>(event: EventName, handler: EventCallback<T>): Promise<UnlistenFn>;
  onResized(
    handler: EventCallback<PhysicalSizeValue>,
  ): Promise<UnlistenFn>;
  onFocusChanged(handler: EventCallback<boolean>): Promise<UnlistenFn>;
  onCloseRequested(
    handler: (event: CloseRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn>;
  outerPosition(): Promise<PhysicalPositionValue>;
  outerSize(): Promise<PhysicalSizeValue>;
  isMaximized(): Promise<boolean>;
  isMinimized(): Promise<boolean>;
  isFocused(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  setTitle(title: string): Promise<void>;
  minimize(): Promise<void>;
  unminimize(): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
  close(): Promise<void>;
  destroy(): Promise<void>;
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<void>;
  setSize(size: WindowSizeValue): Promise<void>;
  setPosition(position: WindowPositionValue): Promise<void>;
  setFocus(): Promise<void>;
  startDragging(): Promise<void>;
}

export interface WindowAdapter {
  getCurrentWindow(): WindowHandle;
  getCurrentWebviewWindow(): WindowHandle;
  getAllWebviewWindows(): Promise<WindowHandle[]>;
  getWebviewWindowByLabel(label: string): Promise<WindowHandle | null>;
  createWebviewWindow(
    label: string,
    options?: WebviewWindowOptions,
  ): WindowHandle;
  currentMonitor(): Promise<Monitor | null>;
}
