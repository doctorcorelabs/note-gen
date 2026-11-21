// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import type { InvokeHandler } from "./handlers";

/**
 * Backend handler for move_paths_to_trash (UTANG-UJI-10): forwards
 * the routed request to POST /api/workspace/trash and returns the
 * batch result { moved, notFound, rejected }. This is the first
 * registered handler in the web wiring; without it the adapter
 * rejects the command with an explicit 501 and workspace file
 * deletion can never work in web mode.
 *
 * The caller (system-trash.ts) sends workspace-relative paths in
 * web mode; the server rejects absolute virtual paths per item as
 * path_escapes_workspace, and the caller treats any rejected item
 * as a failure instead of a silent success.
 */

export interface MovePathsToTrashResult {
  moved: string[];
  notFound: string[];
  rejected: Array<{ path: string; reason: string }>;
}

export interface WorkspaceTrashHandlerDeps {
  /** CSRF token provider for the mutation, same seam as the fs adapter. */
  getCsrfToken?: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
  /** Fetch implementation. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createMovePathsToTrashHandler(
  deps: WorkspaceTrashHandlerDeps = {},
): InvokeHandler {
  return async (context) => {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const token = deps.getCsrfToken ? await deps.getCsrfToken() : undefined;
    const response = await fetchImpl(context.request.path, {
      method: context.request.method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      body: JSON.stringify(context.request.body ?? {}),
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    const envelope = isRecord(parsed) ? parsed : null;
    if (!response.ok || envelope?.ok !== true) {
      throw new Error("Workspace trash request failed.");
    }
    return envelope.data as MovePathsToTrashResult;
  };
}
