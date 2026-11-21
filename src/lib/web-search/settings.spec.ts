// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-14): loadWebSearchSettings degrades to defaults on
// a failed store load so AI model resolution cannot fail
// because web-search settings could not load.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { describe, expect, it, vi } from "vitest";

import type { StoreHandle } from "@/lib/platform";
import type { AiConfig } from "@/app/core/setting/config";
import { loadWebSearchSettings, WEB_SEARCH_API_PROVIDERS } from "./settings";

const DEFAULTS = {
  nativeEnabled: true,
  thirdPartyEnabled: true,
  basicEnabled: true,
  provider: "auto",
  apiKeys: {},
  providerOrder: WEB_SEARCH_API_PROVIDERS,
};

function fakeStore(get: (key: string) => Promise<unknown>): StoreHandle {
  return {
    get,
    set: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
  } as unknown as StoreHandle;
}

describe("SET-14 loadWebSearchSettings", () => {
  it("returns the defaults when the store rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = fakeStore(async () => { throw new Error("store down"); });
    await expect(loadWebSearchSettings(store)).resolves.toEqual(DEFAULTS);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("keeps the legacy migration path unchanged", async () => {
    const store = fakeStore(async () => undefined);
    const aiConfigs = [{
      key: "cfg1",
      title: "Legacy",
      enableWebSearch: true,
      webSearchProvider: "exa",
      webSearchApiKey: "legacy-key",
    }] as AiConfig[];
    await expect(loadWebSearchSettings(store, { aiConfigs, modelId: undefined }))
      .resolves.toEqual({ ...DEFAULTS, apiKeys: { exa: "legacy-key" } });
  });
});
