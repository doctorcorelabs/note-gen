// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Tauri WindowAdapter (V2-13): thin wrapper, no new logic.
 *
 * Desktop behavior must not change: every method delegates to the Tauri
 * window or webviewWindow API exactly as the upstream code used it. This
 * file is the only file in this adapter family allowed to import
 * `@tauri-apps/*`, and only the window specifiers.
 */

import { getCurrentWindow, LogicalSize, PhysicalPosition, type Window } from "@tauri-apps/api/window";
import {
  WebviewWindow,
  getAllWebviewWindows,
  type WebviewWindow as WebviewWindowType,
} from "@tauri-apps/api/webviewWindow";
import type {
  WindowAdapter,
  WindowCapability,
  WindowHandle,
  WindowOpenOptions,
  WindowPosition,
  WindowSize,
} from "./interface";

type TauriWindowLike = Window | WebviewWindowType;

class TauriWindowHandle implements WindowHandle {
  readonly label: string;
  private readonly target: TauriWindowLike;

  constructor(target: TauriWindowLike) {
    this.target = target;
    this.label = target.label;
  }

  async setTitle(title: string): Promise<void> {
    await this.target.setTitle(title);
  }

  async close(): Promise<void> {
    await this.target.close();
  }

  async show(): Promise<void> {
    await this.target.show();
  }

  async hide(): Promise<void> {
    await this.target.hide();
  }

  async setFocus(): Promise<void> {
    await this.target.setFocus();
  }

  async minimize(): Promise<void> {
    await this.target.minimize();
  }

  async isMaximized(): Promise<boolean> {
    return this.target.isMaximized();
  }

  async setSize(size: WindowSize): Promise<void> {
    await this.target.setSize(new LogicalSize(size.width, size.height));
  }

  async setPosition(position: WindowPosition): Promise<void> {
    await this.target.setPosition(new PhysicalPosition(position.x, position.y));
  }

  async setAlwaysOnTop(enabled: boolean): Promise<void> {
    await this.target.setAlwaysOnTop(enabled);
  }

  async startDragging(): Promise<void> {
    await this.target.startDragging();
  }

  async outerPosition(): Promise<WindowPosition> {
    const position = await this.target.outerPosition();
    return { x: position.x, y: position.y };
  }

  async destroy(): Promise<void> {
    await this.target.destroy();
  }
}

export function createTauriWindowAdapter(): WindowAdapter {
  return {
    getCurrent(): WindowHandle {
      return new TauriWindowHandle(getCurrentWindow());
    },

    async getAll(): Promise<WindowHandle[]> {
      const windows = await getAllWebviewWindows();
      return windows.map((target) => new TauriWindowHandle(target));
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
