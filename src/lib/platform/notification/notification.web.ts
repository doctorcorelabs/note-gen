// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web NotificationAdapter (V2-13).
 *
 * System notifications use the browser Notification API when it is
 * available and permission is granted. Every other situation routes to the
 * in-app fallback: an in-memory list (capped at 50, oldest dropped first)
 * that the UI renders as toasts through `onInAppNotification`. A denied or
 * undecided permission never throws and never breaks the caller.
 *
 * Permission flow: `requestPermission` must be called from a user gesture
 * (for example, a settings button). `sendNotification` never prompts; when
 * permission is `default` it uses the in-app fallback and says so in the
 * delivery record.
 *
 * This file must never import `@tauri-apps/*`.
 */

import type { UnlistenFn } from "../event/interface";
import type {
  InAppNotification,
  InAppNotificationListener,
  NotificationAdapter,
  NotificationDelivery,
  NotificationOptions,
  NotificationPermissionState,
} from "./interface";

const MAX_IN_APP_NOTIFICATIONS = 50;

export interface WebNotificationAdapterOptions {
  /** Override for Notification API availability. Defaults to detecting `globalThis.Notification`. */
  isSupported?: boolean;
  /** Current permission without prompting. Defaults to `Notification.permission`. */
  getPermission?: () => NotificationPermissionState;
  /** Prompt the user. Defaults to `Notification.requestPermission()`. */
  requestPermission?: () => Promise<NotificationPermissionState>;
  /** Show a system notification. Defaults to `new Notification(title, options)`. */
  createNotification?: (title: string, options: { body?: string; icon?: string; tag?: string; silent?: boolean }) => void;
  /** Called when an in-app fallback listener throws. Defaults to rethrowing asynchronously. */
  onHandlerError?: (error: unknown, notification: InAppNotification) => void;
}

function detectPermission(): NotificationPermissionState {
  const ctor = (globalThis as { Notification?: { permission?: string } }).Notification;
  if (ctor === undefined) return "denied";
  if (ctor.permission === "granted" || ctor.permission === "denied" || ctor.permission === "default") {
    return ctor.permission;
  }
  return "default";
}

let notificationCounter = 0;

export function createWebNotificationAdapter(
  options: WebNotificationAdapterOptions = {},
): NotificationAdapter {
  const hasApi =
    options.isSupported ??
    (globalThis as { Notification?: unknown }).Notification !== undefined;
  const getPermission = options.getPermission ?? detectPermission;
  const requestPermissionFn =
    options.requestPermission ??
    (async (): Promise<NotificationPermissionState> => {
      const ctor = (globalThis as { Notification?: { requestPermission?: () => Promise<string> } })
        .Notification;
      if (ctor === undefined || typeof ctor.requestPermission !== "function") return "denied";
      const result = await ctor.requestPermission();
      if (result === "granted" || result === "denied" || result === "default") return result;
      return "default";
    });
  const createNotification =
    options.createNotification ??
    ((title: string, init: { body?: string; icon?: string; tag?: string; silent?: boolean }) => {
      const ctor = (globalThis as { Notification?: new (title: string, init?: { body?: string; icon?: string; tag?: string; silent?: boolean }) => unknown })
        .Notification;
      if (ctor === undefined) throw new Error("Notification API is unavailable");
      new ctor(title, init);
    });

  const inApp: InAppNotification[] = [];
  const fallbackListeners = new Set<InAppNotificationListener>();

  function reportHandlerError(error: unknown, notification: InAppNotification): void {
    if (options.onHandlerError !== undefined) {
      options.onHandlerError(error, notification);
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
  }

  function deliverInApp(
    notificationOptions: NotificationOptions,
    permission: NotificationPermissionState,
    reason: string,
  ): NotificationDelivery {
    notificationCounter += 1;
    const notification: InAppNotification = {
      id: `in-app-${Date.now().toString(36)}-${notificationCounter}`,
      title: notificationOptions.title,
      body: notificationOptions.body,
      icon: notificationOptions.icon,
      tag: notificationOptions.tag,
      receivedAt: Date.now(),
    };
    inApp.push(notification);
    while (inApp.length > MAX_IN_APP_NOTIFICATIONS) inApp.shift();
    for (const listener of [...fallbackListeners]) {
      // A failing UI listener must not reject sendNotification or skip the
      // remaining listeners; the notification is already recorded above.
      try {
        listener(notification);
      } catch (error) {
        reportHandlerError(error, notification);
      }
    }
    return { channel: "in-app", permission, title: notificationOptions.title, reason };
  }

  return {
    isSupported(): boolean {
      return hasApi;
    },

    async isPermissionGranted(): Promise<boolean> {
      if (!hasApi) return false;
      return getPermission() === "granted";
    },

    async getPermission(): Promise<NotificationPermissionState> {
      if (!hasApi) return "denied";
      return getPermission();
    },

    async requestPermission(): Promise<NotificationPermissionState> {
      if (!hasApi) return "denied";
      return requestPermissionFn();
    },

    async sendNotification(
      input: NotificationOptions | string,
    ): Promise<NotificationDelivery> {
      const notificationOptions: NotificationOptions =
        typeof input === "string" ? { title: input } : input;
      if (notificationOptions.title.trim() === "") {
        throw new Error("Notification title must not be empty");
      }
      const permission = hasApi ? getPermission() : "denied";
      if (!hasApi) {
        return deliverInApp(
          notificationOptions,
          permission,
          "The Notification API is unavailable in this browser, so the notification was kept in-app.",
        );
      }
      if (permission !== "granted") {
        const reason =
          permission === "denied"
            ? "Notification permission was denied, so the notification was kept in-app."
            : "Notification permission has not been granted yet; call requestPermission() from a user gesture to enable system notifications.";
        return deliverInApp(notificationOptions, permission, reason);
      }
      try {
        createNotification(notificationOptions.title, {
          body: notificationOptions.body,
          icon: notificationOptions.icon,
          tag: notificationOptions.tag,
          silent: notificationOptions.silent,
        });
        return { channel: "system", permission, title: notificationOptions.title };
      } catch {
        return deliverInApp(
          notificationOptions,
          permission,
          "The system notification could not be shown, so the notification was kept in-app.",
        );
      }
    },

    onInAppNotification(listener: InAppNotificationListener): UnlistenFn {
      fallbackListeners.add(listener);
      return () => {
        fallbackListeners.delete(listener);
      };
    },

    getInAppNotifications(): readonly InAppNotification[] {
      return [...inApp];
    },

    clearInAppNotifications(): void {
      inApp.length = 0;
    },
  };
}
