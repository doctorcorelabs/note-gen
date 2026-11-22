// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Behavior specs for the move_paths_to_trash backend handler
// (UTANG-UJI-10): the handler forwards the routed request to
// POST /api/workspace/trash with the CSRF header and unwraps the
// canonical success envelope. No test sends real HTTP.
//
// Run: `pnpm vitest run --project unit src/lib/platform/invoke/workspace-trash-handler.spec.ts`
// from the repo root.

import { describe, expect, it, vi } from "vitest";
import {
  createEmptyWorkspaceTrashHandler,
  createListWorkspaceTrashHandler,
  createMovePathsToTrashHandler,
  createPurgeWorkspaceTrashEntryHandler,
  createRestoreWorkspaceTrashEntryHandler,
} from "./workspace-trash-handler";
import type { InvokeHandlerContext } from "./handlers";

function contextWith(paths: string[]): InvokeHandlerContext {
  return {
    route: {
      command: "move_paths_to_trash",
      method: "POST",
      path: "/api/workspace/trash",
      group: "workspace",
      phase: "1",
    },
    args: { paths },
    request: {
      method: "POST",
      path: "/api/workspace/trash",
      query: {},
      body: { paths },
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("createMovePathsToTrashHandler", () => {
  it("posts the routed body with the CSRF header and returns the batch data", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        data: { moved: ["a.md"], notFound: [], rejected: [] },
      }),
    );
    const handler = createMovePathsToTrashHandler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getCsrfToken: () => "tok-123",
    });

    const result = await handler(contextWith(["a.md"]));

    expect(result).toEqual({ moved: ["a.md"], notFound: [], rejected: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/workspace/trash");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBe(JSON.stringify({ paths: ["a.md"] }));
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-CSRF-Token"]).toBe("tok-123");
  });

  it("omits the CSRF header when no token is available", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        data: { moved: [], notFound: ["gone.md"], rejected: [] },
      }),
    );
    const handler = createMovePathsToTrashHandler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await handler(contextWith(["gone.md"]));

    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("throws on an error envelope instead of returning partial data", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { ok: false, error: { code: "csrf_invalid" } }),
    );
    const handler = createMovePathsToTrashHandler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(handler(contextWith(["a.md"]))).rejects.toThrow(
      "Workspace trash request failed.",
    );
  });

  it("throws on a non-JSON response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    const handler = createMovePathsToTrashHandler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(handler(contextWith(["a.md"]))).rejects.toThrow(
      "Workspace trash request failed.",
    );
  });
});

describe("workspace trash panel handlers (F-05-01)", () => {
  function panelContext(
    command: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    query: Record<string, string>,
    body: unknown,
  ): InvokeHandlerContext {
    return {
      route: { command, method, path, group: "workspace", phase: "1" },
      args: {},
      request: { method, path, query, body },
    };
  }

  it("list sends a GET with the cursor query and no body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        data: { entries: [], nextCursor: null, hasMore: false, totalCount: 0, totalSize: 0 },
      }),
    );
    const handler = createListWorkspaceTrashHandler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getCsrfToken: () => "tok-123",
    });

    const result = await handler(
      panelContext("list_workspace_trash", "GET", "/api/workspace/trash", { limit: "50", cursor: "abc" }, undefined),
    );

    expect(result).toEqual({ entries: [], nextCursor: null, hasMore: false, totalCount: 0, totalSize: 0 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/workspace/trash?limit=50&cursor=abc");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("restore posts to the entry restore path", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        data: { id: "e1", originalPath: "a.md", restoredPath: "a.md", kind: "file", revision: null, size: 3, restoredAt: "2026-11-22T00:00:00.000Z" },
      }),
    );
    const handler = createRestoreWorkspaceTrashEntryHandler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getCsrfToken: () => "tok-123",
    });

    await handler(
      panelContext("restore_workspace_trash_entry", "POST", "/api/workspace/trash/e1/restore", {}, {}),
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/workspace/trash/e1/restore");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("tok-123");
  });

  it("purge deletes the entry path", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, data: { id: "e1", purged: true, purgedAt: "2026-11-22T00:00:00.000Z" } }),
    );
    const handler = createPurgeWorkspaceTrashEntryHandler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await handler(
      panelContext("purge_workspace_trash_entry", "DELETE", "/api/workspace/trash/e1", {}, {}),
    );

    expect(result).toEqual({ id: "e1", purged: true, purgedAt: "2026-11-22T00:00:00.000Z" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/workspace/trash/e1");
    expect(init.method).toBe("DELETE");
  });

  it("empty trash sends the confirm body the server requires", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, data: { purged: 2, failed: 0, failures: [], purgedAt: "2026-11-22T00:00:00.000Z" } }),
    );
    const handler = createEmptyWorkspaceTrashHandler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getCsrfToken: () => "tok-123",
    });

    const result = await handler(
      panelContext("empty_workspace_trash", "DELETE", "/api/workspace/trash", {}, { confirm: true }),
    );

    expect(result).toEqual({ purged: 2, failed: 0, failures: [], purgedAt: "2026-11-22T00:00:00.000Z" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/workspace/trash");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(JSON.stringify({ confirm: true }));
  });

  it("forwards the server error code and message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { ok: false, error: { code: "already_exists", message: "Target exists." } }),
    );
    const handler = createRestoreWorkspaceTrashEntryHandler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      handler(panelContext("restore_workspace_trash_entry", "POST", "/api/workspace/trash/e1/restore", {}, {})),
    ).rejects.toThrow("already_exists");
  });
});
