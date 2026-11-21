// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-2 (ACT-02): bridge the web in-app notification fallback to
// the toast surface. The fallback adapter (notification.web.ts)
// was designed for the UI to render held notifications through
// onInAppNotification, but nothing subscribed, so any future
// caller relying on the fallback would lose notifications
// silently. This helper owns the subscription so it can be unit
// tested with a fake adapter; the React component in
// components/in-app-notification-toasts.tsx only wires it to the
// platform registry and the toast hook.

import type {
  InAppNotification,
  NotificationAdapter,
  NotificationAdapterExtensions,
} from "./interface";

export type InAppToastFn = (toast: {
  title: string;
  description?: string;
}) => void;

type NotificationSurface = NotificationAdapter &
  Partial<NotificationAdapterExtensions>;

/**
 * Subscribe to in-app fallback notifications and forward each one
 * to the toast surface. Returns an unsubscribe function, or null
 * when the adapter has no in-app fallback surface (for example
 * the tauri adapter, where system notifications are native).
 */
export function subscribeInAppNotificationToasts(
  adapter: NotificationSurface,
  showToast: InAppToastFn,
): (() => void) | null {
  if (typeof adapter.onInAppNotification !== "function") {
    return null;
  }
  const unlisten = adapter.onInAppNotification(
    (notification: InAppNotification) => {
      showToast({
        title: notification.title,
        description: notification.body,
      });
    },
  );
  return () => {
    void unlisten();
  };
}
