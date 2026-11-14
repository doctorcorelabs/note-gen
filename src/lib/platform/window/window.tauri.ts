// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Tauri WindowAdapter (V2-13, reconciled to the canonical G0 interface in M12).
 *
 * Thin wrapper, no new logic: every method delegates to the Tauri window
 * or webviewWindow API exactly as the upstream code used it. Sizes and
 * positions cross the boundary as plain structural values (the interface
 * cannot provide class constructors); this file converts them to the
 * upstream classes on the way in and to plain tagged values on the way
 * out. This file is the only file in this adapter family allowed to
 * import `@tauri-apps/*`, and only the window specifiers.
 */

import {
  LogicalPosition,
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
  currentMonitor as currentTauriMonitor,
  getCurrentWindow,
  type Monitor as TauriMonitor,
  type Window,
} from "@tauri-apps/api/window";
import {
  WebviewWindow,
  getAllWebviewWindows,
  getCurrentWebviewWindow,
  type WebviewWindow as WebviewWindowType,
} from "@tauri-apps/api/webviewWindow";
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

type TauriWindowLike = Window | WebviewWindowType;

function toPlainMonitor(monitor: TauriMonitor): Monitor {
  return {
    name: monitor.name,
    size: { type: "Physical", width: monitor.size.width, height: monitor.size.height },
    position: { type: "Physical", x: monitor.position.x, y: monitor.position.y },
    workArea: {
      position: {
        type: "Physical",
        x: monitor.workArea.position.x,
        y: monitor.workArea.position.y,
      },
      size: {
        type: "Physical",
        width: monitor.workArea.size.width,
        height: monitor.workArea.size.height,
      },
    },
    scaleFactor: monitor.scaleFactor,
  };
}

class TauriWindowHandle implements WindowHandle {
  readonly label: string;
  private readonly target: TauriWindowLike;

  constructor(target: TauriWindowLike) {
    this.target = target;
    this.label = target.label;
  }

  async listen<T>(event: EventName, handler: EventCallback<T>): Promise<UnlistenFn> {
    return this.target.listen<T>(event, handler);
  }

  async once<T>(event: EventName, handler: EventCallback<T>): Promise<UnlistenFn> {
    return this.target.once<T>(event, handler);
  }

  async onResized(handler: EventCallback<PhysicalSizeValue>): Promise<UnlistenFn> {
    return this.target.onResized(handler);
  }

  async onFocusChanged(handler: EventCallback<boolean>): Promise<UnlistenFn> {
    return this.target.onFocusChanged(handler);
  }

  async onCloseRequested(
    handler: (event: CloseRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn> {
    return this.target.onCloseRequested(handler);
  }

  async outerPosition(): Promise<PhysicalPositionValue> {
    const position = await this.target.outerPosition();
    return { type: "Physical", x: position.x, y: position.y };
  }

  async outerSize(): Promise<PhysicalSizeValue> {
    const size = await this.target.outerSize();
    return { type: "Physical", width: size.width, height: size.height };
  }

  async isMaximized(): Promise<boolean> {
    return this.target.isMaximized();
  }

  async isMinimized(): Promise<boolean> {
    return this.target.isMinimized();
  }

  async isFocused(): Promise<boolean> {
    return this.target.isFocused();
  }

  async isVisible(): Promise<boolean> {
    return this.target.isVisible();
  }

  async setTitle(title: string): Promise<void> {
    await this.target.setTitle(title);
  }

  async minimize(): Promise<void> {
    await this.target.minimize();
  }

  async unminimize(): Promise<void> {
    await this.target.unminimize();
  }

  async toggleMaximize(): Promise<void> {
    await this.target.toggleMaximize();
  }

  async show(): Promise<void> {
    await this.target.show();
  }

  async hide(): Promise<void> {
    await this.target.hide();
  }

  async close(): Promise<void> {
    await this.target.close();
  }

  async destroy(): Promise<void> {
    await this.target.destroy();
  }

  async setAlwaysOnTop(enabled: boolean): Promise<void> {
    await this.target.setAlwaysOnTop(enabled);
  }

  async setSize(size: WindowSizeValue): Promise<void> {
    await this.target.setSize(
      size.type === "Logical"
        ? new LogicalSize(size.width, size.height)
        : new PhysicalSize(size.width, size.height),
    );
  }

  async setPosition(position: WindowPositionValue): Promise<void> {
    await this.target.setPosition(
      position.type === "Logical"
        ? new LogicalPosition(position.x, position.y)
        : new PhysicalPosition(position.x, position.y),
    );
  }

  async setFocus(): Promise<void> {
    await this.target.setFocus();
  }

  async startDragging(): Promise<void> {
    await this.target.startDragging();
  }
}

export function createTauriWindowAdapter(): WindowAdapter & WindowAdapterWebExtensions {
  return {
    getCurrentWindow(): WindowHandle {
      return new TauriWindowHandle(getCurrentWindow());
    },

    getCurrentWebviewWindow(): WindowHandle {
      return new TauriWindowHandle(getCurrentWebviewWindow());
    },

    async getAllWebviewWindows(): Promise<WindowHandle[]> {
      const windows = await getAllWebviewWindows();
      return windows.map((target) => new TauriWindowHandle(target));
    },

    async getWebviewWindowByLabel(label: string): Promise<WindowHandle | null> {
      const found = await WebviewWindow.getByLabel(label);
      return found === null ? null : new TauriWindowHandle(found);
    },

    createWebviewWindow(label: string, options?: WebviewWindowOptions): WindowHandle {
      return new TauriWindowHandle(new WebviewWindow(label, options));
    },

    async currentMonitor(): Promise<Monitor | null> {
      const monitor = await currentTauriMonitor();
      return monitor === null ? null : toPlainMonitor(monitor);
    },

    async openWindow(options: WindowOpenOptions): Promise<WindowHandle | null> {
      const created = new WebviewWindow(options.label, {
        url: options.url,
        title: options.title,
      });
      return new TauriWindowHandle(created);
    },

    async isFullscreen(): Promise<boolean> {
      return getCurrentWindow().isFullscreen();
    },

    async requestFullscreen(): Promise<boolean> {
      await getCurrentWindow().setFullscreen(true);
      return true;
    },

    async exitFullscreen(): Promise<boolean> {
      await getCurrentWindow().setFullscreen(false);
      return true;
    },

    isSupported(capability: WindowCapability): boolean {
      void capability;
      return true;
    },
  };
}
