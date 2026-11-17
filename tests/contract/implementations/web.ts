// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Web column factories for the Store contract suite (3E-STOREWIRE).
 *
 * `webStoreFactory` runs the real web adapter
 * (`createWebStoreAdapter`) with production deps: the key-schema
 * `classifyKey`, a dummy CSRF provider, and a fake settings server
 * behind the `fetchImpl` seam. The fake server speaks the canonical
 * envelope (`kontrak-api-kanonis.md` section 3.2): GET returns the
 * document plus revision, PATCH applies settings under the
 * baseRevision guard and answers 409 `revision_conflict` with the
 * fresh document in `details` when the base is stale, and a null
 * value in PATCH settings deletes the key. The CSRF header is
 * required on mutations with the dummy test token, so a wiring
 * regression that drops the provider fails loudly instead of
 * passing silently.
 *
 * Each `create()` builds a fresh server plus a fresh localStorage
 * map, so no state is shared between cases. `reopen()` returns a
 * new adapter over the SAME server: the two adapters hold separate
 * caches and the server is the only shared state, so C-ST-01 and
 * C-ST-06 prove a save plus refetch round-trip, never a shared
 * in-memory document. The localStorage map is shared across a
 * reopen on purpose: it models one browser's localStorage, which
 * every adapter instance on the page sees. BroadcastChannel is
 * disabled (`null`), so cross-tab notices cannot leak between
 * cases; cross-tab behavior belongs to the API cases, not here.
 *
 * Teardown closes the created adapter AND every sibling created by
 * `reopen()` over the same backing: the harness tears down only
 * the instance it created, and a reopened adapter left open would
 * keep an unrefed flush timer and an unflushed queue past the
 * case. Siblings are tracked per backing; a reopen of an unknown
 * adapter throws instead of inventing a backing.
 *
 * `webCorruptStoreFactory` runs the same adapter against an
 * unreachable backend: every request throws, so `load()` rejects
 * with `StoreWebError` (`network_error`). That is the web column
 * for C-ST-04; see EXCEPTIONS.md E12.
 *
 * Import note: this factory imports the adapter factory module
 * directly instead of going through the registry. The registry is
 * global and freezes, so it cannot serve isolated per-case
 * instances with an injected fake transport; the direct import
 * follows the adapter specs' precedent and stays inside
 * `src/lib/platform/`. No `@tauri-apps` import appears here.
 */

import { classifyKey } from "../../../src/lib/platform/store/key-schema";
import {
  createWebStoreAdapter,
  type StoreWebFetch,
  type StoreWebFetchResponse,
  type StoreWebStorage,
} from "../../../src/lib/platform/store/store.web";
import type { ContractFactory } from "../contract-harness";
import type { StoreAdapter } from "../contract-types";
import type { StoreContractFactory } from "../store-cases";

/** Synthetic CSRF token for the contract column; never a real secret. */
const CSRF_TEST_TOKEN = "test-csrf-token";

const SETTINGS_URL = "/api/settings";
const SECRETS_PUT_URL = "/api/settings/secrets/ai-providers";
const CSRF_HEADER = "X-CSRF-Token";

interface FakeSettingsServer {
  revision: number;
  settings: Record<string, unknown>;
}

function jsonResponse(
  status: number,
  body: unknown,
): StoreWebFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function requireCsrfToken(headers: Record<string, string>): void {
  if (headers[CSRF_HEADER] !== CSRF_TEST_TOKEN) {
    throw new Error(
      "contract fake server: mutation without the expected CSRF token",
    );
  }
}

function createFakeSettingsFetch(
  server: FakeSettingsServer,
): StoreWebFetch {
  return async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = init.headers ?? {};
    if (url === SETTINGS_URL && method === "GET") {
      return jsonResponse(200, {
        ok: true,
        data: {
          revision: server.revision,
          settings: structuredClone(server.settings),
        },
      });
    }
    if (url === SETTINGS_URL && method === "PATCH") {
      requireCsrfToken(headers);
      const body = JSON.parse(init.body ?? "{}") as {
        settings?: Record<string, unknown>;
        baseRevision?: unknown;
      };
      if (body.baseRevision !== server.revision) {
        return jsonResponse(409, {
          ok: false,
          error: {
            code: "revision_conflict",
            message: "Settings revision conflict",
            details: {
              revision: server.revision,
              settings: structuredClone(server.settings),
            },
          },
        });
      }
      const applied: string[] = [];
      for (const [key, value] of Object.entries(body.settings ?? {})) {
        if (value === null) {
          delete server.settings[key];
        } else {
          server.settings[key] = structuredClone(value);
        }
        applied.push(key);
      }
      server.revision += 1;
      return jsonResponse(200, {
        ok: true,
        data: { revision: server.revision, applied, rejected: [] },
      });
    }
    if (url === SECRETS_PUT_URL && method === "PUT") {
      requireCsrfToken(headers);
      return jsonResponse(200, { ok: true, data: {} });
    }
    return jsonResponse(404, {
      ok: false,
      error: {
        code: "not_found",
        message: `Unknown contract fake route ${method} ${url}`,
      },
    });
  };
}

function createMapStorage(
  backing: Map<string, string>,
): StoreWebStorage {
  return {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => {
      backing.set(key, value);
    },
    removeItem: (key) => {
      backing.delete(key);
    },
  };
}

interface WebStoreBacking {
  server: FakeSettingsServer;
  localStorage: Map<string, string>;
  adapters: Set<StoreAdapter>;
}

const backingsByAdapter = new WeakMap<StoreAdapter, WebStoreBacking>();

function freshBacking(): WebStoreBacking {
  return {
    server: { revision: 0, settings: {} },
    localStorage: new Map<string, string>(),
    adapters: new Set<StoreAdapter>(),
  };
}

function createAdapterOver(backing: WebStoreBacking): StoreAdapter {
  const adapter = createWebStoreAdapter({
    fetchImpl: createFakeSettingsFetch(backing.server),
    classifyKey,
    getCsrfToken: () => CSRF_TEST_TOKEN,
    storage: createMapStorage(backing.localStorage),
    broadcastChannelImpl: null,
  });
  backing.adapters.add(adapter);
  backingsByAdapter.set(adapter, backing);
  return adapter;
}

export const webStoreFactory: StoreContractFactory = {
  name: "web",
  create: () => createAdapterOver(freshBacking()),
  teardown: async (impl) => {
    const backing = backingsByAdapter.get(impl);
    const targets =
      backing !== undefined ? [...backing.adapters] : [impl];
    for (const adapter of targets) {
      await adapter.closeAll();
    }
  },
  reopen: async (impl) => {
    const backing = backingsByAdapter.get(impl);
    if (backing === undefined) {
      throw new Error(
        "Web store contract factory can only reopen an adapter it created",
      );
    }
    return createAdapterOver(backing);
  },
};

async function unreachableFetch(): Promise<StoreWebFetchResponse> {
  throw new Error("contract fake server: backend unreachable");
}

export const webCorruptStoreFactory: ContractFactory<StoreAdapter> = {
  name: "web-corrupt",
  create: () =>
    createWebStoreAdapter({
      fetchImpl: unreachableFetch,
      classifyKey,
      getCsrfToken: () => CSRF_TEST_TOKEN,
      storage: createMapStorage(new Map<string, string>()),
      broadcastChannelImpl: null,
    }),
  teardown: async (impl) => {
    await impl.closeAll();
  },
};
