// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * InvokeAdapter and ChannelAdapter interfaces (migration wave G2).
 *
 * Replace the invoke, Channel, and transformCallback surface of
 * api/core. Signatures mirror the installed upstream declarations
 * (api 2.11.1). The typed command router of G2 builds on top of this
 * raw contract; it does not replace it. Command names stay plain
 * strings here, exactly as call sites pass them today.
 *
 * ChannelHandle values may appear nested inside invoke arguments (the
 * AI streaming client passes its channel as an argument). Both
 * implementations must recognize handles nested in arguments: the Tauri
 * implementation converts them to upstream channels, and the web
 * implementation subscribes the matching server-sent stream.
 *
 * transformCallback is the internal seam for the Tauri event listener
 * that relocates into the platform directory at G2; it has no meaning
 * in web mode, where the web implementation reports the capability as
 * unavailable. The isTauri function is not part of any adapter; runtime
 * detection lives in detect.ts.
 *
 * Merge M9 reconciliation (audit V2-40): this file keeps the G0
 * raw contract whole. The router-level types from V2-05
 * (BackendRoute, transport, stream surface) moved to
 * invoke/router.ts; the invoke/index.ts barrel was deleted.
 */
export type InvokeArgs =
  | Record<string, unknown>
  | number[]
  | ArrayBuffer
  | Uint8Array;

export interface InvokeOptions {
  headers: HeadersInit;
}

export interface ChannelHandle<T = unknown> {
  readonly id: number;
  onmessage: (response: T) => void;
}

export interface ChannelAdapter {
  createChannel<T = unknown>(
    onmessage?: (response: T) => void,
  ): ChannelHandle<T>;
}

export interface InvokeAdapter {
  invoke<T>(
    cmd: string,
    args?: InvokeArgs,
    options?: InvokeOptions,
  ): Promise<T>;
  transformCallback<T = unknown>(
    callback?: (response: T) => void,
    once?: boolean,
  ): number;
}
