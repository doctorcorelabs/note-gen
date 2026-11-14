// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Invoke and channel adapter contracts for the web fork.
 *
 * The web adapter routes every Tauri-style command through exactly one of
 * three paths: a safe local stub, a dedicated backend endpoint, or an
 * explicit typed rejection. There is no generic invoke endpoint: the
 * transport path always comes from the route table in routes.ts, never
 * from the command name, and the command name is never sent as request
 * data to a dedicated endpoint.
 *
 * Callers use these interfaces through the platform registry. They never
 * check the runtime mode themselves and never import Tauri packages.
 * The Tauri implementation is a thin wrapper over the real Tauri
 * primitives and is wired by a later wave; this file is mode neutral
 * so both implementations can satisfy it.
 */

/** JSON-style arguments passed to a command, with camelCase keys. */
export type InvokeArgs = Record<string, unknown>;

export interface InvokeOptions {
  readonly signal?: AbortSignal;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Triage phase that owns the backend endpoint for a command. */
export type BackendPhase = "1" | "2" | "3b" | "3d" | "3e";

export type BackendGroup =
  | "ai"
  | "backups"
  | "documents"
  | "search"
  | "imports"
  | "plugins"
  | "db"
  | "skills"
  | "workspace"
  | "clipper";

/**
 * One registered backend route. Paths are relative and same-origin.
 * Placeholders such as {requestId} are substituted from arguments with
 * the same camelCase key; see web.ts.
 */
export interface BackendRoute {
  readonly command: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly group: BackendGroup;
  readonly phase: BackendPhase;
  /** True only for the reserved SSE stream route. Never fetched in MVP. */
  readonly stream?: boolean;
}

/**
 * One backend request as seen by the transport. The adapter builds this
 * from the route table; the transport only performs the HTTP call.
 */
export interface BackendTransportRequest {
  readonly method: HttpMethod;
  /** Resolved path with placeholders substituted, without a query string. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** Validated JSON body. Undefined for GET requests. */
  readonly body: unknown;
  readonly signal?: AbortSignal;
}

export interface BackendTransportResponse {
  readonly status: number;
  /** Parsed JSON body (an envelope), or null when the body is not JSON. */
  readonly body: unknown;
}

/**
 * HTTP transport for backend routes. The transport owns fetch, cookies,
 * and CSRF handling; the adapter owns routing, validation, and error
 * mapping. No transport is registered in the MVP skeleton, so every
 * backend command rejects with an explicit not-implemented error until
 * a later wave supplies a transport and marks routes available.
 */
export type BackendTransport = (
  request: BackendTransportRequest,
) => Promise<BackendTransportResponse>;

/** Typed invoke surface, mirroring the Tauri invoke() shape. */
export interface InvokeAdapter {
  invoke<T = unknown>(
    command: string,
    args?: InvokeArgs,
    options?: InvokeOptions,
  ): Promise<T>;
}

/**
 * Streaming events, mirroring the desktop StreamEvent shape: chunk
 * carries one JSON piece, error carries a message string, and done
 * closes the iterable. The web transport for this shape is SSE over
 * fetch in a later phase; in the MVP the web adapter rejects every
 * stream request explicitly instead of returning an empty iterable.
 */
export type StreamEvent<T> =
  | { type: "chunk"; data: T }
  | { type: "error"; data: string }
  | { type: "done" };

/** Streaming surface for the single command that uses a channel. */
export interface ChannelAdapter {
  stream<T = unknown>(
    command: string,
    args?: InvokeArgs,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<T>>;
}
