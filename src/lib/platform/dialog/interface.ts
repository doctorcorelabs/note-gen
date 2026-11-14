// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * DialogAdapter interface (migration wave G3).
 *
 * Replaces the upstream plugin-dialog surface: open, save, confirm, ask,
 * message. Signatures mirror the installed upstream declarations
 * (plugin-dialog 2.x), including the generic conditional return type of
 * open and the string-or-options second argument of message, ask, and
 * confirm. No call site imports the option types directly; the shapes
 * below are redeclared so implementations and migrated call sites share
 * one contract.
 */
export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  filters?: DialogFilter[];
  defaultPath?: string;
  multiple?: boolean;
  directory?: boolean;
  recursive?: boolean;
  canCreateDirectories?: boolean;
}

export interface SaveDialogOptions {
  title?: string;
  filters?: DialogFilter[];
  defaultPath?: string;
  canCreateDirectories?: boolean;
}

export interface MessageDialogOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
}

export interface ConfirmDialogOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
}

export type OpenDialogReturn<T extends OpenDialogOptions> =
  T["directory"] extends true
    ? T["multiple"] extends true
      ? string[] | null
      : string | null
    : T["multiple"] extends true
      ? string[] | null
      : string | null;

export interface DialogAdapter {
  open<T extends OpenDialogOptions>(
    options?: T,
  ): Promise<OpenDialogReturn<T>>;
  save(options?: SaveDialogOptions): Promise<string | null>;
  message(
    message: string,
    options?: string | MessageDialogOptions,
  ): Promise<void>;
  ask(
    message: string,
    options?: string | ConfirmDialogOptions,
  ): Promise<boolean>;
  confirm(
    message: string,
    options?: string | ConfirmDialogOptions,
  ): Promise<boolean>;
}
