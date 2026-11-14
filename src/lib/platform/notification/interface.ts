// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * NotificationAdapter interface (V2-13).
 *
 * Local interface definition for this adapter family, following the V1-05
 * inventory (desain-registry-shim.md section 1.10). V2-04 owns the canonical
 * interfaces; the integrator reconciles this definition with the canonical
 * one. Callers must use the adapter through the platform registry, never by
 * importing an implementation file directly.
 *
 * Upstream surface replaced: `isPermissionGranted`, `requestPermission`,
 * `sendNotification` from `@tauri-apps/plugin-notification` (3 importing
 * files upstream).
 *
 * Web behavior: the browser Notification API is used when it is available
 * and permission is granted. In every other case the notification is routed
 * to the in-app fallback (an in-memory list the UI renders as toasts) and
 * the delivery record says so. A denied permission never throws and never
 * breaks the caller flow; it is recorded in the delivery record instead.
 * `sendNotification` never requests permission by itself: permission
 * requests must come from a user gesture through `requestPermission`.
 */

import type { UnlistenFn } from "../event/interface";

export type NotificationPermissionState = "granted" | "denied" | "default";

export interface NotificationOptions {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  silent?: boolean;
}

export type NotificationChannel = "system" | "in-app";

export interface NotificationDelivery {
  /** Where the notification actually went. */
  channel: NotificationChannel;
  /** Permission state observed at send time. */
  permission: NotificationPermissionState;
  title: string;
  /** Human-readable reason when the channel is `in-app`. */
  reason?: string;
}

export interface InAppNotification {
  id: string;
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  receivedAt: number;
}

export type InAppNotificationListener = (notification: InAppNotification) => void;

export interface NotificationAdapter {
  /** True when system notifications can be shown in the running mode. */
  isSupported(): boolean;

  /** True only when system notification permission is currently granted. */
  isPermissionGranted(): Promise<boolean>;

  /** Current permission state without prompting the user. */
  getPermission(): Promise<NotificationPermissionState>;

  /**
   * Ask the user for notification permission. Must be called from a user
   * gesture. Returns the resulting permission state. When the Notification
   * API is unavailable on the web, returns `denied`.
   */
  requestPermission(): Promise<NotificationPermissionState>;

  /**
   * Show a notification. Uses the system channel when permission is granted,
   * otherwise the in-app fallback. Always resolves with a delivery record;
   * it throws only for invalid options (for example, an empty title).
   */
  sendNotification(options: NotificationOptions | string): Promise<NotificationDelivery>;

  /** Subscribe to in-app fallback notifications so the UI can render them. */
  onInAppNotification(listener: InAppNotificationListener): UnlistenFn;

  /** Notifications currently held by the in-app fallback, oldest first. */
  getInAppNotifications(): readonly InAppNotification[];

  /** Clear the in-app fallback list. */
  clearInAppNotifications(): void;
}
