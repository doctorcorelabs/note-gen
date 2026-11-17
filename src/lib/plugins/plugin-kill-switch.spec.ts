// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for the plugin kill switch (W4-SEC, H4-KILL G0-G3).
//
// Runner: Vitest, unit project (vitest run --project unit). The suite
// runs in a Node environment with no Tauri shell marker, which is the
// web-mode branch of the switch. The desktop exemption branch is
// exercised with the test-only marker seam from the platform detect
// leaf; the marker is always restored, because the kill switch reads
// it uncached.

import { describe, expect, it } from "vitest";

import { isPluginError, PluginError } from "@notegen/plugin-api";

import { __setTauriInternalsForTests } from "../platform/detect";

import {
  assertPluginsEnabled,
  isPluginKillSwitchActive,
  PLUGIN_KILL_SWITCH_MESSAGE,
  PLUGIN_WEB_PHASE,
} from "./plugin-kill-switch";

describe("plugin kill switch", () => {
  it("pins the build phase to off", () => {
    expect(PLUGIN_WEB_PHASE).toBe("off");
  });

  it("is active in a non-Tauri runtime", () => {
    expect(isPluginKillSwitchActive()).toBe(true);
  });

  it("is inactive when the Tauri shell marker is present", () => {
    __setTauriInternalsForTests(true);
    try {
      expect(isPluginKillSwitchActive()).toBe(false);
      expect(() => assertPluginsEnabled()).not.toThrow();
    } finally {
      __setTauriInternalsForTests(false);
    }
    expect(isPluginKillSwitchActive()).toBe(true);
  });

  it("rejects with an explicit UnavailableOnPlatform error", () => {
    let caught: unknown;
    try {
      assertPluginsEnabled();
    } catch (error) {
      caught = error;
    }
    expect(isPluginError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe("UnavailableOnPlatform");
    expect((caught as PluginError).message).toBe(PLUGIN_KILL_SWITCH_MESSAGE);
  });
});
