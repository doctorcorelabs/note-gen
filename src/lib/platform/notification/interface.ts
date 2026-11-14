// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * NotificationAdapter interface (migration wave G4).
 *
 * Replaces the upstream plugin-notification surface used by the
 * codebase: isPermissionGranted, requestPermission, sendNotification.
 * Signatures mirror the installed upstream declarations
 * (plugin-notification 2.x). sendNotification is synchronous upstream
 * and stays synchronous here; the single call site passes { title, body }
 * without awaiting. The options bag is named NotificationOptions here
 * (upstream name: Options) so the platform barrel stays unambiguous.
 *
 * The channel, pending/active, action-type, and listener functions are
 * not imported anywhere and are excluded.
 */
import type { UnlistenFn } from "../event/interface";

export interface NotificationAttachment {
  id: string;
  url: string;
}

export interface NotificationScheduleInterval {
  year?: number;
  month?: number;
  day?: number;
  weekday?: number;
  hour?: number;
  minute?: number;
  second?: number;
}

export type NotificationScheduleEvery =
  | "year"
  | "month"
  | "twoWeeks"
  | "week"
  | "day"
  | "hour"
  | "minute"
  | "second";

export interface NotificationSchedule {
  at?: {
    date: Date;
    repeating: boolean;
    allowWhileIdle: boolean;
  };
  interval?: {
    interval: NotificationScheduleInterval;
    allowWhileIdle: boolean;
  };
  every?: {
    interval: NotificationScheduleEvery;
    count: number;
    allowWhileIdle: boolean;
  };
}

/** Upstream Visibility enum values: -1 secret, 0 private, 1 public. */
export type NotificationVisibility = -1 | 0 | 1;

export interface NotificationOptions {
  id?: number;
  channelId?: string;
  title: string;
  body?: string;
  schedule?: NotificationSchedule;
  largeBody?: string;
  summary?: string;
  actionTypeId?: string;
  group?: string;
  groupSummary?: boolean;
  sound?: string;
  inboxLines?: string[];
  icon?: string;
  /** Fork addition (M12 reconciliation): browser Notification tag and
   * in-app fallback grouping. Stripped before the Tauri plugin call. */
  tag?: string;
  largeIcon?: string;
  iconColor?: string;
  attachments?: NotificationAttachment[];
  extra?: Record<string, unknown>;
  ongoing?: boolean;
  autoCancel?: boolean;
  silent?: boolean;
  visibility?: NotificationVisibility;
  number?: number;
}

export interface NotificationAdapter {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<NotificationPermission>;
  sendNotification(options: NotificationOptions | string): void;
}

/** Permission states shared by the web adapter and the in-app fallback. */
export type NotificationPermissionState = "granted" | "denied" | "default";

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

/**
 * Fork additions (M12 reconciliation, from V2-13): the web in-app fallback
 * surface. The canonical sendNotification stays synchronous and void, as
 * upstream; sendNotificationDetailed is the async variant that reports
 * where the notification went. Implementations expose both surfaces;
 * callers that need the fallback use the factory return type
 * (NotificationAdapter & NotificationAdapterExtensions).
 */
export interface NotificationAdapterExtensions {
  /** True when system notifications can be shown in the running mode. */
  isSupported(): boolean;
  /** Current permission state without prompting the user. */
  getPermission(): Promise<NotificationPermissionState>;
  /**
   * Show a notification and report the delivery. Uses the system channel
   * when permission is granted, otherwise the in-app fallback. It throws
   * only for invalid options (for example, an empty title).
   */
  sendNotificationDetailed(
    options: NotificationOptions | string,
  ): Promise<NotificationDelivery>;
  /** Subscribe to in-app fallback notifications so the UI can render them. */
  onInAppNotification(listener: InAppNotificationListener): UnlistenFn;
  /** Notifications currently held by the in-app fallback, oldest first. */
  getInAppNotifications(): readonly InAppNotification[];
  /** Clear the in-app fallback list. */
  clearInAppNotifications(): void;
}
