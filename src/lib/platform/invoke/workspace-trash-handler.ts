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

// DA-6 F10: server batch cap (kontrak 3.1) and a fetch timeout so
// a hung request cannot stall the caller forever.
const TRASH_BATCH_LIMIT = 100;
const TRASH_REQUEST_TIMEOUT_MS = 30000;

export function createMovePathsToTrashHandler(
  deps: WorkspaceTrashHandlerDeps = {},
): InvokeHandler {
  return async (context) => {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const token = deps.getCsrfToken ? await deps.getCsrfToken() : undefined;

    async function sendBatch(body: unknown): Promise<MovePathsToTrashResult> {
      const response = await fetchImpl(context.request.path, {
        method: context.request.method,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-CSRF-Token": token } : {}),
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(TRASH_REQUEST_TIMEOUT_MS),
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      const envelope = isRecord(parsed) ? parsed : null;
      if (!response.ok || envelope?.ok !== true) {
        // DA-6 F10: forward the server envelope code and message
        // instead of collapsing every failure into one generic
        // string.
        const serverError = isRecord(envelope?.error) ? envelope.error : null;
        const code = typeof serverError?.code === "string" ? serverError.code : `http_${response.status}`;
        const message = typeof serverError?.message === "string" ? serverError.message : "Workspace trash request failed.";
        throw new Error(`Workspace trash request failed (${code}): ${message}`);
      }
      return envelope.data as MovePathsToTrashResult;
    }

    const body = isRecord(context.request.body) ? context.request.body : {};
    const paths = body["paths"];
    if (!Array.isArray(paths) || paths.length <= TRASH_BATCH_LIMIT) {
      return sendBatch(context.request.body ?? {});
    }
    const merged: MovePathsToTrashResult = { moved: [], notFound: [], rejected: [] };
    for (let offset = 0; offset < paths.length; offset += TRASH_BATCH_LIMIT) {
      const batch = await sendBatch({ ...body, paths: paths.slice(offset, offset + TRASH_BATCH_LIMIT) });
      merged.moved.push(...batch.moved);
      merged.notFound.push(...batch.notFound);
      merged.rejected.push(...batch.rejected);
    }
    return merged;
  };
}
