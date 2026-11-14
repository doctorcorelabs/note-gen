// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web WindowAdapter (V2-13, reconciled to the canonical G0 interface in M12).
 *
 * Binding behavior: explicit window controls are disabled, except
 * `document.title`, focus/visibility queries for the current tab, and the
 * DOM fullscreen API when it is safe to use. Disabled controls throw
 * `PlatformCapabilityError` so callers and UI can tell the difference
 * between "not available" and "worked".
 *
 * Tab handles returned by `openWindow` support title, focus, and close on
 * the opened tab (same-origin app routes, opened with `noopener`). All other
 * controls throw for tab handles too. Windows cannot be enumerated in a
 * browser, so the window queries return only the current tab.
 *
 * This file must never import `@tauri-apps/*`.
 */

import { capabilityError } from "../errors";
import type { EventCallback, EventName, UnlistenFn } from "../event/interface";
import type {
  CloseRequestedEvent,
  Monitor,
  PhysicalPositionValue,
  PhysicalSizeValue,
  WebviewWindowOptions,
  WindowAdapter,
  WindowAdapterWebExtensions,
  WindowCapability,
  WindowHandle,
  WindowOpenOptions,
  WindowPositionValue,
  WindowSizeValue,
} from "./interface";

const ADAPTER = "window";

function unsupported(capability: string, reason: string): never {
  throw capabilityError("unsupported", ADAPTER, capability, "web", reason);
}

function currentDocument(): Document | null {
  return typeof document !== "undefined" ? document : null;
}

function currentWindow(): Window | null {
  return typeof window !== "undefined" ? window : null;
}

class WebWindowHandle implements WindowHandle {
  readonly label: string;
  private readonly tab: WindowProxy | null;

  constructor(label: string, tab: WindowProxy | null) {
    this.label = label;
    this.tab = tab;
  }

  private get isCurrent(): boolean {
    return this.tab === null;
  }

  async listen<T>(event: EventName, handler: EventCallback<T>): Promise<UnlistenFn> {
    void event;
    void handler;
    unsupported("listen", "window handle events have no web equivalent; use the event adapter instead");
  }

  async once<T>(event: EventName, handler: EventCallback<T>): Promise<UnlistenFn> {
    void event;
    void handler;
    unsupported("once", "window handle events have no web equivalent; use the event adapter instead");
  }

  async onResized(handler: EventCallback<PhysicalSizeValue>): Promise<UnlistenFn> {
    void handler;
    unsupported("onResized", "browser tabs expose no resize event on a window handle");
  }

  async onFocusChanged(handler: EventCallback<boolean>): Promise<UnlistenFn> {
    void handler;
    unsupported(
      "onFocusChanged",
      "browser tabs expose no focus-change event on a window handle; use the event adapter tauri://focus and tauri://blur names instead",
    );
  }

  async onCloseRequested(
    handler: (event: CloseRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn> {
    void handler;
    unsupported("onCloseRequested", "browser tabs have no close-requested event");
  }

  async outerPosition(): Promise<PhysicalPositionValue> {
    unsupported("outerPosition", "browser tabs expose no outer position");
  }

  async outerSize(): Promise<PhysicalSizeValue> {
    unsupported("outerSize", "browser tabs expose no outer size");
  }

  async isMaximized(): Promise<boolean> {
    unsupported("isMaximized", "browser tabs have no maximized state");
  }

  async isMinimized(): Promise<boolean> {
    unsupported("isMinimized", "browser tabs have no minimized state");
  }

  async isFocused(): Promise<boolean> {
    if (!this.isCurrent) {
      unsupported("isFocused", "focus state of another tab cannot be observed from this tab");
    }
    const doc = currentDocument();
    if (doc === null) {
      unsupported("isFocused", "no document is available (server-side rendering)");
    }
    return doc.hasFocus();
  }

  async isVisible(): Promise<boolean> {
    if (!this.isCurrent) {
      unsupported("isVisible", "visibility of another tab cannot be observed from this tab");
    }
    const doc = currentDocument();
    if (doc === null) {
      unsupported("isVisible", "no document is available (server-side rendering)");
    }
    return doc.visibilityState !== "hidden";
  }

  async setTitle(title: string): Promise<void> {
    if (this.isCurrent) {
      const doc = currentDocument();
      if (doc === null) {
        unsupported("setTitle", "no document is available (server-side rendering)");
      }
      doc.title = title;
      return;
    }
    // Same-origin tab opened by this app. Access fails when the tab
    // navigated away or the browser isolates it; report that honestly.
    try {
      const tabDocument = this.tab?.document;
      if (tabDocument === undefined || tabDocument === null) {
        unsupported("setTitle", "the opened tab does not expose its document");
      }
      tabDocument.title = title;
    } catch (error) {
      if (error instanceof Error && error.name === "PlatformCapabilityError") throw error;
      unsupported("setTitle", "the opened tab title cannot be set from this tab");
    }
  }

  async minimize(): Promise<void> {
    unsupported("minimize", "browser tabs have no minimize control");
  }

  async unminimize(): Promise<void> {
    unsupported("unminimize", "browser tabs have no minimize control");
  }

  async toggleMaximize(): Promise<void> {
    unsupported("toggleMaximize", "browser tabs have no maximize control");
  }

  async show(): Promise<void> {
    unsupported("show", "browser tabs have no show control");
  }

  async hide(): Promise<void> {
    unsupported("hide", "browser tabs have no hide control");
  }

  async close(): Promise<void> {
    if (!this.isCurrent) {
      this.tab?.close();
      return;
    }
    unsupported("close", "a browser tab cannot be closed programmatically unless it was opened by script");
  }

  async destroy(): Promise<void> {
    unsupported("destroy", "browser tabs have no destroy control; close the tab instead");
  }

  async setAlwaysOnTop(enabled: boolean): Promise<void> {
    void enabled;
    unsupported("setAlwaysOnTop", "browser tabs have no always-on-top control");
  }

  async setSize(size: WindowSizeValue): Promise<void> {
    void size;
    unsupported("setSize", "browser tabs have no size control");
  }

  async setPosition(position: WindowPositionValue): Promise<void> {
    void position;
    unsupported("setPosition", "browser tabs have no position control");
  }

  async setFocus(): Promise<void> {
    if (!this.isCurrent) {
      this.tab?.focus();
      return;
    }
    unsupported("setFocus", "the current browser tab cannot be focused programmatically in a meaningful way");
  }

  async startDragging(): Promise<void> {
    unsupported("startDragging", "browser tabs have no native drag region");
  }
}

const SUPPORTED: Readonly<Record<WindowCapability, boolean>> = {
  close: false,
  show: false,
  hide: false,
  setFocus: false,
  setTitle: true,
  setAlwaysOnTop: false,
  isMaximized: false,
  setSize: false,
  setPosition: false,
  startDragging: false,
  outerPosition: false,
  minimize: false,
  destroy: false,
  fullscreen: true,
  openWindow: true,
  toggleMaximize: false,
  unminimize: false,
  isMinimized: false,
  isFocused: true,
  isVisible: true,
  outerSize: false,
};

export interface WebWindowAdapterOptions {
  /** Override for the current-tab label, used by tests and multi-tab shells. Defaults to `main`. */
  label?: string;
}

export function createWebWindowAdapter(
  options: WebWindowAdapterOptions = {},
): WindowAdapter & WindowAdapterWebExtensions {
  const label = options.label ?? "main";
  const current = new WebWindowHandle(label, null);

  return {
    getCurrentWindow(): WindowHandle {
      return current;
    },

    getCurrentWebviewWindow(): WindowHandle {
      return current;
    },

    async getAllWebviewWindows(): Promise<WindowHandle[]> {
      return [current];
    },

    async getWebviewWindowByLabel(lookup: string): Promise<WindowHandle | null> {
      return lookup === label ? current : null;
    },

    createWebviewWindow(
      newLabel: string,
      createOptions?: WebviewWindowOptions,
    ): WindowHandle {
      void newLabel;
      void createOptions;
      return unsupported(
        "createWebviewWindow",
        "synchronous window creation has no web equivalent; use openWindow() instead, which opens a new tab asynchronously and can be blocked by the browser",
      );
    },

    async currentMonitor(): Promise<Monitor | null> {
      return null;
    },

    async openWindow(openOptions: WindowOpenOptions): Promise<WindowHandle | null> {
      const win = currentWindow();
      if (win === null) return null;
      const url = openOptions.url;
      if (!url.startsWith("/") && !url.startsWith(win.location.origin)) {
        throw new Error(
          `Invalid window URL "${url}": openWindow only accepts app routes or same-origin URLs`,
        );
      }
      const tab = win.open(url, "_blank", "noopener");
      if (tab === null) return null;
      return new WebWindowHandle(openOptions.label, tab);
    },

    async isFullscreen(): Promise<boolean> {
      const doc = currentDocument();
      return doc !== null && doc.fullscreenElement !== null;
    },

    async requestFullscreen(): Promise<boolean> {
      const doc = currentDocument();
      if (doc === null) return false;
      const element = doc.documentElement;
      if (typeof element.requestFullscreen !== "function") return false;
      try {
        await element.requestFullscreen();
        return true;
      } catch {
        // Rejected, for example because the call was not triggered by a
        // user gesture. Report false instead of throwing.
        return false;
      }
    },

    async exitFullscreen(): Promise<boolean> {
      const doc = currentDocument();
      if (doc === null || doc.fullscreenElement === null) return false;
      if (typeof doc.exitFullscreen !== "function") return false;
      try {
        await doc.exitFullscreen();
        return true;
      } catch {
        return false;
      }
    },

    isSupported(capability: WindowCapability): boolean {
      return SUPPORTED[capability];
    },
  };
}
