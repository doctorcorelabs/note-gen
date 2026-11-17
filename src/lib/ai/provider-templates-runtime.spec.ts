// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for the local-only provider template loader (AD-15,
// gelombang 4). The loader reads only the pinned JSON bundles under
// config/; there is no Config Center fetch, no cache, and no network.
// The validation table below mirrors desain-h4-key.md section 10.4:
// every row runs against normalizeTemplateRecords, the exact function
// loadProviderTemplates uses.
//
// Runner: Vitest, unit project (vitest run --project unit). Pure
// functions plus pinned JSON imports; no DOM, no network. The
// storefront policy is mocked so both bundles can be exercised
// without the platform chain.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getProviderTemplateMatch,
  loadProviderTemplates,
  normalizeTemplateRecords,
} from "./provider-templates-runtime";

const storefront = vi.hoisted(() => ({ mainland: false }));

vi.mock("@/lib/ai/storefront-policy", () => ({
  excludeBuiltInOpenAIProviders: (templates: unknown[]) => templates,
  isMainlandChinaAppStore: async () => storefront.mainland,
}));

beforeEach(() => {
  storefront.mainland = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function record(overrides: Record<string, unknown> = {}) {
  return {
    key: "example",
    title: "Example",
    baseURL: "https://api.example.com/v1",
    ...overrides,
  };
}

describe("normalizeTemplateRecords validation table", () => {
  it("accepts a plain HTTPS entry and stamps builtin metadata", () => {
    const [entry] = normalizeTemplateRecords([record()]);
    expect(entry.key).toBe("example");
    expect(entry.title).toBe("Example");
    expect(entry.baseURL).toBe("https://api.example.com/v1");
    expect(entry.templateKey).toBe("example");
    expect(entry.templateSource).toBe("builtin");
  });

  it("accepts HTTP loopback only for the pinned local providers", () => {
    // One record per call: duplicate keys are dropped, so the four
    // allowlisted host forms cannot share a single input list.
    const forms: Array<[string, string]> = [
      ["ollama", "http://localhost:11434/v1"],
      ["ollama", "http://127.0.0.1:11434/v1"],
      ["lmstudio", "http://localhost:1234/v1"],
      ["lmstudio", "http://127.0.0.1:1234/v1"],
    ];
    for (const [key, baseURL] of forms) {
      const kept = normalizeTemplateRecords([record({ key, baseURL })]);
      expect(kept).toHaveLength(1);
      expect(kept[0].key).toBe(key);
    }
  });

  it("drops HTTP loopback for any other key, and any non-loopback HTTP", () => {
    const kept = normalizeTemplateRecords([
      record({ key: "other", baseURL: "http://localhost:11434/v1" }),
      record({ key: "ollama", baseURL: "http://localhost:9999/v1" }),
      record({ key: "example", baseURL: "http://api.example.com/v1" }),
    ]);
    expect(kept).toEqual([]);
  });

  it("drops userinfo, query, and fragment in baseURL", () => {
    const kept = normalizeTemplateRecords([
      record({ key: "a", baseURL: "https://user:pass@api.example.com/v1" }),
      record({ key: "b", baseURL: "https://api.example.com/v1?ref=1" }),
      record({ key: "c", baseURL: "https://api.example.com/v1#frag" }),
    ]);
    expect(kept).toEqual([]);
  });

  it("drops the metadata host and private literal IPs even over HTTPS", () => {
    const kept = normalizeTemplateRecords([
      record({ key: "a", baseURL: "https://metadata.google.internal/v1" }),
      record({ key: "b", baseURL: "https://10.0.0.1/v1" }),
      record({ key: "c", baseURL: "https://192.168.1.5/v1" }),
      record({ key: "d", baseURL: "https://172.16.0.9/v1" }),
      record({ key: "e", baseURL: "https://127.0.0.1:8443/v1" }),
    ]);
    expect(kept).toEqual([]);
  });

  it("drops non-HTTPS schemes", () => {
    const kept = normalizeTemplateRecords([
      record({ key: "a", baseURL: "ftp://api.example.com/v1" }),
      record({ key: "b", baseURL: "file:///etc/passwd" }),
      record({ key: "c", baseURL: "not a url" }),
    ]);
    expect(kept).toEqual([]);
  });

  it("drops duplicates, keeping the first entry", () => {
    const kept = normalizeTemplateRecords([
      record({ title: "First" }),
      record({ title: "Second" }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe("First");
  });

  it("drops disabled entries and entries without key, title, or baseURL", () => {
    const kept = normalizeTemplateRecords([
      record({ enabled: false }),
      record({ key: "" }),
      record({ title: "  " }),
      record({ baseURL: "" }),
      record({ key: 42 }),
      null,
      "text",
    ]);
    expect(kept).toEqual([]);
  });

  it("never copies secret, sponsor, or proxy fields from the bundle", () => {
    const [entry] = normalizeTemplateRecords([
      record({
        apiKey: "sk-should-never-appear",
        sponsored: true,
        promotion: "50% off",
        customHeaders: { Authorization: "Bearer x" },
        proxy: "https://proxy.example.com",
      }),
    ]);
    expect(entry).toBeDefined();
    expect("apiKey" in entry).toBe(false);
    expect("sponsored" in entry).toBe(false);
    expect("promotion" in entry).toBe(false);
    expect("customHeaders" in entry).toBe(false);
    expect("proxy" in entry).toBe(false);
  });

  it("neutralizes apiKeyUrl to origin plus path, dropping query and fragment", () => {
    const [entry] = normalizeTemplateRecords([
      record({ apiKeyUrl: "https://console.example.com/keys?ref=abc#top" }),
    ]);
    expect(entry.apiKeyUrl).toBe("https://console.example.com/keys");
  });

  it("drops non-HTTPS or userinfo apiKeyUrl values", () => {
    const kept = normalizeTemplateRecords([
      record({ key: "a", apiKeyUrl: "http://console.example.com/keys" }),
      record({ key: "b", apiKeyUrl: "https://user@console.example.com/keys" }),
    ]);
    expect(kept[0].apiKeyUrl).toBeUndefined();
    expect(kept[1].apiKeyUrl).toBeUndefined();
  });

  it("keeps only HTTPS icons", () => {
    const kept = normalizeTemplateRecords([
      record({ key: "a", icon: "https://cdn.example.com/a.png" }),
      record({ key: "b", icon: "http://cdn.example.com/b.png" }),
      record({ key: "c", icon: "data:image/png;base64,xx" }),
    ]);
    expect(kept[0].icon).toBe("https://cdn.example.com/a.png");
    expect(kept[1].icon).toBeUndefined();
    expect(kept[2].icon).toBeUndefined();
  });
});

describe("loadProviderTemplates pinned bundles", () => {
  it("returns all 28 regular-bundle entries with zero dropped", async () => {
    const templates = await loadProviderTemplates([]);
    expect(templates).toHaveLength(28);
    expect(templates.map((entry) => entry.key)).toContain("chatgpt");
  });

  it("returns all 27 China-bundle entries without chatgpt", async () => {
    storefront.mainland = true;
    const templates = await loadProviderTemplates([]);
    expect(templates).toHaveLength(27);
    expect(templates.map((entry) => entry.key)).not.toContain("chatgpt");
  });

  it("every returned entry is a validated builtin record without secrets", async () => {
    for (const mainland of [false, true]) {
      storefront.mainland = mainland;
      const templates = await loadProviderTemplates([]);
      for (const entry of templates) {
        expect(entry.templateSource).toBe("builtin");
        expect(entry.templateKey).toBe(entry.key);
        expect("apiKey" in entry).toBe(false);
        expect("sponsored" in entry).toBe(false);
        expect("promotion" in entry).toBe(false);
        const url = new URL(entry.baseURL as string);
        expect(url.username).toBe("");
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
        if (url.protocol === "http:") {
          expect(["ollama", "lmstudio"]).toContain(entry.key);
          expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
        } else {
          expect(url.protocol).toBe("https:");
        }
      }
    }
  });
});

describe("getProviderTemplateMatch", () => {
  it("matches by templateKey first, then by baseURL", async () => {
    const templates = await loadProviderTemplates([]);
    const ollama = templates.find((entry) => entry.key === "ollama");
    expect(ollama).toBeDefined();
    expect(
      getProviderTemplateMatch({ key: "x", title: "X", templateKey: "ollama" }, templates),
    ).toEqual(ollama);
    expect(
      getProviderTemplateMatch(
        { key: "x", title: "X", baseURL: ollama?.baseURL },
        templates,
      ),
    ).toEqual(ollama);
  });

  it("returns null without a config, without templates, or without a match", async () => {
    const templates = await loadProviderTemplates([]);
    expect(getProviderTemplateMatch(undefined, templates)).toBeNull();
    expect(getProviderTemplateMatch({ key: "x", title: "X" }, [])).toBeNull();
    expect(
      getProviderTemplateMatch(
        { key: "x", title: "X", baseURL: "https://nowhere.example.com/v1" },
        templates,
      ),
    ).toBeNull();
  });
});
