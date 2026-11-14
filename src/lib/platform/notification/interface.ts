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
