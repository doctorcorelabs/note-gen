// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-06): role-value predicates for clearing stale model
// roles on delete. Values use three formats: bare model id,
// composite `${configKey}-${modelId}`, legacy bare config key.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { describe, expect, it } from "vitest";

import { roleValueReferencesConfig, roleValueReferencesModel } from "./model-role-refs";

describe("SET-06 roleValueReferencesModel", () => {
  it("matches the bare model id", () => {
    expect(roleValueReferencesModel("m1", "cfg1", "m1")).toBe(true);
  });

  it("matches the composite configKey-modelId format", () => {
    expect(roleValueReferencesModel("cfg1-m1", "cfg1", "m1")).toBe(true);
  });

  it("does not match another model or another provider", () => {
    expect(roleValueReferencesModel("m2", "cfg1", "m1")).toBe(false);
    expect(roleValueReferencesModel("cfg2-m1", "cfg1", "m1")).toBe(false);
  });

  it("never matches an empty role value", () => {
    expect(roleValueReferencesModel("", "cfg1", "m1")).toBe(false);
  });
});

describe("SET-06 roleValueReferencesConfig", () => {
  it("matches the legacy bare config key", () => {
    expect(roleValueReferencesConfig("cfg1", "cfg1", ["m1"])).toBe(true);
  });

  it("matches any composite value under the config key", () => {
    expect(roleValueReferencesConfig("cfg1-m9", "cfg1", ["m1"])).toBe(true);
  });

  it("matches a bare model id owned by the config", () => {
    expect(roleValueReferencesConfig("m1", "cfg1", ["m1", "m2"])).toBe(true);
  });

  it("does not match values of other providers", () => {
    expect(roleValueReferencesConfig("cfg2", "cfg1", ["m1"])).toBe(false);
    expect(roleValueReferencesConfig("cfg2-m1", "cfg1", ["m1"])).toBe(false);
    expect(roleValueReferencesConfig("m9", "cfg1", ["m1"])).toBe(false);
  });

  it("never matches an empty role value", () => {
    expect(roleValueReferencesConfig("", "cfg1", ["m1"])).toBe(false);
  });
});
