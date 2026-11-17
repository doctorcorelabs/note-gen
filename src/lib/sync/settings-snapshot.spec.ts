// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for the sponsor-gateway purge in settings snapshots
// (AD-15, gelombang 4). The purge predicate in settings-snapshot.ts
// is the structural twin of isSponsorGatewayConfig in
// src/stores/setting.ts; both copies must agree. The store module
// itself is not imported here because its import chain (zustand,
// platform adapters) is unsuitable for the node test environment;
// parity between the two copies is maintained by review in the same
// patch. These tests pin the snapshot twin's behavior.
//
// Alias note: Vitest in this repo does not resolve the `@/` alias
// for transitive imports (no other unit suite imports a module with
// `@/` imports; see vitest.config.ts). The vi.mock calls below do
// NOT stub behavior: each one re-exports the real dependency module
// through a relative path so the module under test can load. If
// alias resolution is fixed globally, these mocks can be deleted
// without changing any test.
//
// Runner: Vitest, unit project (vitest run --project unit). Pure
// function; no DOM, no network.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/speech/preferences", async () => await import("../speech/preferences"));
vi.mock("@/config/sync-exclusions", async () => await import("../../config/sync-exclusions"));
vi.mock("@/lib/editor-layout-styles", async () => await import("../editor-layout-styles"));
vi.mock("@/lib/outline-preferences", async () => await import("../outline-preferences"));
vi.mock("@/lib/record-display-preferences", async () => await import("../record-display-preferences"));
vi.mock("@/lib/record-save-preferences", async () => await import("../record-save-preferences"));
vi.mock("@/lib/canvas/preferences", async () => await import("../canvas/preferences"));
vi.mock("@/lib/ai/system-prompt", async () => await import("../ai/system-prompt"));

import { normalizeSettingsSnapshot } from "./settings-snapshot";

const NO_SENSITIVE_FILTER = { excludeSensitiveConfig: false };

function providerList() {
  return [
    {
      key: "gateway-by-host",
      title: "Gateway",
      baseURL: "https://api.notegen.top/v1",
      models: [{ id: "other-model" }],
    },
    {
      key: "gateway-by-template",
      title: "Gateway",
      baseURL: "https://elsewhere.example.com/v1",
      templateKey: "note-gen-free",
      models: [],
    },
    {
      key: "gateway-by-model",
      title: "Gateway",
      baseURL: "https://elsewhere.example.com/v1",
      models: [{ id: "note-gen-chat" }],
    },
    {
      key: "gateway-by-embedding",
      title: "Gateway",
      baseURL: "https://elsewhere.example.com/v1",
      models: [{ id: "note-gen-embedding" }],
    },
    {
      key: "gateway-by-stt",
      title: "Gateway",
      baseURL: "https://elsewhere.example.com/v1",
      models: [{ id: "note-gen-stt" }],
    },
    {
      key: "user-provider",
      title: "Mine",
      baseURL: "https://api.example.com/v1",
      models: [{ id: "my-model" }],
    },
  ];
}

describe("normalizeSettingsSnapshot sponsor purge", () => {
  it("removes every sponsor gateway config and keeps user providers", () => {
    const result = normalizeSettingsSnapshot(
      { aiModelList: providerList() },
      {},
      NO_SENSITIVE_FILTER,
    );
    const kept = result.aiModelList as Array<{ key: string }>;
    expect(kept).toHaveLength(1);
    expect(kept[0].key).toBe("user-provider");
  });

  it("keeps a user config whose hostname merely contains the gateway host", () => {
    const result = normalizeSettingsSnapshot(
      {
        aiModelList: [
          {
            key: "lookalike",
            title: "Lookalike",
            baseURL: "https://api.notegen.top.evil.example.com/v1",
            models: [{ id: "my-model" }],
          },
        ],
      },
      {},
      NO_SENSITIVE_FILTER,
    );
    const kept = result.aiModelList as Array<{ key: string }>;
    expect(kept).toHaveLength(1);
    expect(kept[0].key).toBe("lookalike");
  });

  it("clears legacy model selections that pointed at the sponsor gateway", () => {
    const result = normalizeSettingsSnapshot(
      {
        primaryModel: "note-gen-chat",
        editorModel: "note-gen-free-note-gen-chat",
        placeholderModel: "note-gen-limited-7",
        imageMethodModel: "note-gen-vlm",
        completionModel: "note-gen-embedding",
        markDescModel: "my-model",
        commitModel: "",
      },
      {},
      NO_SENSITIVE_FILTER,
    );
    expect(result.primaryModel).toBe("");
    expect(result.editorModel).toBe("");
    expect(result.placeholderModel).toBe("");
    expect(result.imageMethodModel).toBe("");
    expect(result.completionModel).toBe("");
    expect(result.markDescModel).toBe("my-model");
    expect(result.commitModel).toBe("");
  });

  it("never maps a cleared selection back to a sponsor model id", () => {
    const result = normalizeSettingsSnapshot(
      { primaryModel: "note-gen-free-chat" },
      {},
      NO_SENSITIVE_FILTER,
    );
    expect(result.primaryModel).toBe("");
    expect(result.primaryModel).not.toBe("note-gen-chat");
  });

  it("with the default sensitive filter, aiModelList is excluded entirely", () => {
    const result = normalizeSettingsSnapshot({ aiModelList: providerList() }, {});
    expect("aiModelList" in result).toBe(false);
  });
});
