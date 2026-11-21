// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-01, SET-13): ModelSelect grouping by provider key
// and awaited persist ordering, tested through the extracted
// pure helpers.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { describe, expect, it } from "vitest";

import {
  groupModelsByConfig,
  persistModelSelection,
  type GroupedModel,
  type ModelSelectionStore,
} from "./model-select-helpers";

function item(configKey: string, configTitle: string, modelId: string): GroupedModel {
  return {
    configKey,
    configTitle,
    model: { id: modelId, model: modelId, modelType: "chat" },
  };
}

describe("SET-13 groupModelsByConfig", () => {
  it("keeps same-title providers in separate groups", () => {
    const groups = groupModelsByConfig([
      item("cfg1", "Custom", "m1"),
      item("cfg2", "Custom", "m2"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.configKey)).toEqual(["cfg1", "cfg2"]);
  });

  it("merges models of one provider into one group", () => {
    const groups = groupModelsByConfig([
      item("cfg1", "Custom", "m1"),
      item("cfg1", "Custom", "m2"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map(entry => entry.model.id)).toEqual(["m1", "m2"]);
  });

  it("keeps first-appearance group order", () => {
    const groups = groupModelsByConfig([
      item("cfg2", "B", "m2"),
      item("cfg1", "A", "m1"),
      item("cfg2", "B", "m3"),
    ]);
    expect(groups.map(group => group.configKey)).toEqual(["cfg2", "cfg1"]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupModelsByConfig([])).toEqual([]);
  });
});

describe("SET-01 persistModelSelection", () => {
  it("awaits set before save", async () => {
    const calls: string[] = [];
    const store: ModelSelectionStore = {
      set: async () => { calls.push("set"); },
      save: async () => { calls.push("save"); },
    };
    await persistModelSelection(store, "primaryModel", "m1");
    expect(calls).toEqual(["set", "save"]);
  });

  it("propagates a rejected set and never saves", async () => {
    const calls: string[] = [];
    const store: ModelSelectionStore = {
      set: async () => { calls.push("set"); throw new Error("store closed"); },
      save: async () => { calls.push("save"); },
    };
    await expect(persistModelSelection(store, "primaryModel", "m1"))
      .rejects.toThrow("store closed");
    expect(calls).toEqual(["set"]);
  });
});
