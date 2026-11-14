// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web WindowAdapter (V2-13).
 *
 * Binding behavior: explicit window controls are disabled, except
 * `document.title` and the DOM fullscreen API when it is safe to use.
 * Disabled controls throw `PlatformCapabilityError` so callers and UI can
 * tell the difference between "not available" and "worked".
 *
 * Tab handles returned by `openWindow` support title, focus, and close on
 * the opened tab (same-origin app routes, opened with `noopener`). All other
 * controls throw for tab handles too. `getAll` cannot enumerate browser
 * tabs and returns only the current tab.
 *
 * This file must never import `@tauri-apps/*`.
 */

import { capabilityError } from "../errors";
import type {
  WindowAdapter,
  WindowCapability,
  WindowHandle,
  WindowOpenOptions,
  WindowPosition,
  WindowSize,
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

  async close(): Promise<void> {
    if (!this.isCurrent) {
      this.tab?.close();
      return;
    }
    unsupported("close", "a browser tab cannot be closed programmatically unless it was opened by script");
  }

  async show(): Promise<void> {
    unsupported("show", "browser tabs have no show control");
  }

  async hide(): Promise<void> {
    unsupported("hide", "browser tabs have no hide control");
  }

  async setFocus(): Promise<void> {
    if (!this.isCurrent) {
      this.tab?.focus();
      return;
    }
    unsupported("setFocus", "the current browser tab cannot be focused programmatically in a meaningful way");
  }

  async minimize(): Promise<void> {
    unsupported("minimize", "browser tabs have no minimize control");
  }

  async isMaximized(): Promise<boolean> {
    unsupported("isMaximized", "browser tabs have no maximized state");
  }

  async setSize(_size: WindowSize): Promise<void> {
    unsupported("setSize", "browser tabs have no size control");
  }

  async setPosition(_position: WindowPosition): Promise<void> {
    unsupported("setPosition", "browser tabs have no position control");
  }

  async setAlwaysOnTop(_enabled: boolean): Promise<void> {
    unsupported("setAlwaysOnTop", "browser tabs have no always-on-top control");
  }

  async startDragging(): Promise<void> {
    unsupported("startDragging", "browser tabs have no native drag region");
  }

  async outerPosition(): Promise<WindowPosition> {
    unsupported("outerPosition", "browser tabs expose no outer position");
  }

  async destroy(): Promise<void> {
    unsupported("destroy", "browser tabs have no destroy control; close the tab instead");
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
};

export interface WebWindowAdapterOptions {
  /** Override for the current-tab label, used by tests and multi-tab shells. Defaults to `main`. */
  label?: string;
}

export function createWebWindowAdapter(options: WebWindowAdapterOptions = {}): WindowAdapter {
  const label = options.label ?? "main";
  const current = new WebWindowHandle(label, null);

  return {
    getCurrent(): WindowHandle {
      return current;
    },

    async getAll(): Promise<WindowHandle[]> {
      return [current];
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
