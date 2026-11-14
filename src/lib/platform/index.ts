// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Public entry point of the platform registry (AD-23).
 *
 * Callers import adapters, detection helpers, errors, and capability
 * flags from here only, never from adapter subdirectories and never
 * from an implementation file. This barrel is the only module outside
 * the adapter subdirectories that may name the adapter interfaces.
 *
 * Detection names: the canonical names are the skeleton names
 * (getPlatformMode, isTauri, PlatformMode). The getRuntimeMode,
 * isTauriRuntime, isWebRuntime, and RuntimeMode names are compatibility
 * aliases for the names used in the registry design document; they
 * describe the same detection and add no behavior.
 */

import { getPlatformMode } from "./detect";

export { getPlatformMode, isTauri, type PlatformMode } from "./detect";
export {
  getPlatformMode as getRuntimeMode,
  isTauri as isTauriRuntime,
  type PlatformMode as RuntimeMode,
} from "./detect";

export function isWebRuntime(): boolean {
  return getPlatformMode() === "web";
}

export {
  capabilities,
  freezeRegistry,
  getAdapter,
  getCapabilities,
  getCurrentMode,
  getPlatform,
  getPlatformAdapter,
  hasAdapter,
  isRegistryFrozen,
  listAdapters,
  platform,
  registerAdapter,
  registerPlatformAdapter,
  __resetPlatformForTests,
  type AdapterName,
  type AdapterRegistration,
  type PlatformAdapters,
  type PlatformCapabilities,
} from "./registry";

export {
  capabilityError,
  PlatformCapabilityError,
  type CapabilityErrorCode,
  type PlatformCapabilityErrorDetails,
} from "./errors";

export type { AssetUrlAdapter } from "./asset/interface";
export type { AutostartAdapter } from "./autostart/interface";
export type {
  ChannelAdapter,
  ChannelHandle,
  InvokeAdapter,
  InvokeArgs,
  InvokeOptions,
} from "./invoke/interface";
export type { ClipboardAdapter } from "./clipboard/interface";
export type {
  ConfirmDialogOptions,
  DialogAdapter,
  DialogFilter,
  MessageDialogOptions,
  OpenDialogOptions,
  OpenDialogReturn,
  SaveDialogOptions,
} from "./dialog/interface";
export type {
  Event,
  EventAdapter,
  EventCallback,
  EventListenOptions,
  EventName,
  EventTarget,
  TauriEvent,
  UnlistenFn,
} from "./event/interface";
export { BaseDirectory } from "./fs/interface";
export type {
  CopyFileOptions,
  DebouncedWatchOptions,
  DirEntry,
  ExistsOptions,
  FileInfo,
  FsAdapter,
  FsFileHandle,
  MkdirOptions,
  OpenOptions,
  ReadDirOptions,
  ReadFileOptions,
  RemoveOptions,
  RenameOptions,
  StatOptions,
  UnwatchFn,
  WatchEvent,
  WatchEventKind,
  WatchEventKindAccess,
  WatchEventKindCreate,
  WatchEventKindModify,
  WatchEventKindRemove,
  WatchOptions,
  WriteFileOptions,
} from "./fs/interface";
export type {
  ClientOptions,
  DangerousSettings,
  HttpAdapter,
  Proxy,
  ProxyConfig,
} from "./http/interface";
export type {
  NotificationAdapter,
  NotificationAttachment,
  NotificationOptions,
  NotificationSchedule,
  NotificationScheduleEvery,
  NotificationScheduleInterval,
  NotificationVisibility,
} from "./notification/interface";
export type { OpenerAdapter } from "./opener/interface";
export type { OsAdapter, OsArch, OsPlatform } from "./os/interface";
export type { PathAdapter } from "./path/interface";
export type { ProcessAdapter } from "./process/interface";
export type { ShellAdapter } from "./shell/interface";
export type {
  ShortcutAdapter,
  ShortcutEvent,
  ShortcutHandler,
} from "./shortcut/interface";
export type { SqlAdapter } from "./sql/interface";
export type {
  StoreAdapter,
  StoreHandle,
  StoreOptions,
} from "./store/interface";
export type {
  UpdateCheckOptions,
  UpdateDownloadEvent,
  UpdateDownloadOptions,
  UpdateInfo,
  UpdaterAdapter,
} from "./updater/interface";
export type {
  CloseRequestedEvent,
  LogicalPositionValue,
  LogicalSizeValue,
  Monitor,
  PhysicalPositionValue,
  PhysicalSizeValue,
  WebviewWindowOptions,
  WindowAdapter,
  WindowHandle,
  WindowPositionValue,
  WindowSizeValue,
  WindowTitleBarStyle,
} from "./window/interface";
