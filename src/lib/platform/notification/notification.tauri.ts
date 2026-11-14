// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Tauri NotificationAdapter (V2-13): thin wrapper, no new logic.
 *
 * Desktop behavior must not change: permission and sending delegate to
 * `@tauri-apps/plugin-notification` exactly as the upstream code used it.
 * There is no in-app fallback on desktop; the fallback methods are no-ops
 * returning empty state.
 *
 * Limitation: the plugin exposes no permission getter that distinguishes
 * `denied` from `default` without prompting, so `getPermission` returns
 * `default` whenever permission is not granted. Callers that need the exact
 * denied state must use `requestPermission`, which may prompt.
 *
 * This file is the only file in this adapter family allowed to import
 * `@tauri-apps/*`, and only the notification specifier.
 */

import {
  isPermissionGranted,
  requestPermission as requestTauriPermission,
  sendNotification as sendTauriNotification,
} from "@tauri-apps/plugin-notification";
import type { UnlistenFn } from "../event/interface";
import type {
  InAppNotification,
  InAppNotificationListener,
  NotificationAdapter,
  NotificationDelivery,
  NotificationOptions,
  NotificationPermissionState,
} from "./interface";

export function createTauriNotificationAdapter(): NotificationAdapter {
  return {
    isSupported(): boolean {
      return true;
    },

    async isPermissionGranted(): Promise<boolean> {
      return isPermissionGranted();
    },

    async getPermission(): Promise<NotificationPermissionState> {
      return (await isPermissionGranted()) ? "granted" : "default";
    },

    async requestPermission(): Promise<NotificationPermissionState> {
      const result = await requestTauriPermission();
      if (result === "granted" || result === "denied" || result === "default") return result;
      return "default";
    },

    async sendNotification(input: NotificationOptions | string): Promise<NotificationDelivery> {
      const notificationOptions: NotificationOptions =
        typeof input === "string" ? { title: input } : input;
      if (notificationOptions.title.trim() === "") {
        throw new Error("Notification title must not be empty");
      }
      sendTauriNotification({ title: notificationOptions.title, body: notificationOptions.body });
      return {
        channel: "system",
        permission: (await isPermissionGranted()) ? "granted" : "default",
        title: notificationOptions.title,
      };
    },

    onInAppNotification(_listener: InAppNotificationListener): UnlistenFn {
      return () => undefined;
    },

    getInAppNotifications(): readonly InAppNotification[] {
      return [];
    },

    clearInAppNotifications(): void {
      // No in-app fallback on desktop; nothing to clear.
    },
  };
}
