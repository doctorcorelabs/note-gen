// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for src/lib/window-route-mapping.ts (Fase 1, V3-24).
// Runner: Vitest, unit project. No DOM, no network, no storage.

import { describe, expect, it } from "vitest";

import {
  buildBrowserTabUrlForWindowRoute,
  DESKTOP_WINDOW_ROUTE_MAP,
  getWindowRouteMapping,
  openWindowRouteInBrowserTab,
} from "./window-route-mapping";

describe("getWindowRouteMapping", () => {
  it("maps all five desktop window routes from audit section 6.1", () => {
    expect(DESKTOP_WINDOW_ROUTE_MAP.map((mapping) => mapping.route)).toEqual([
      "/editor-window",
      "/print",
      "/quick-record",
      "/screenshot",
      "/screenshot-pin",
    ]);
  });

  it("assigns the audit replacement to each route", () => {
    expect(getWindowRouteMapping("/editor-window")?.replacement).toBe("browser-tab");
    expect(getWindowRouteMapping("/print")?.replacement).toBe("browser-dialog");
    expect(getWindowRouteMapping("/quick-record")?.replacement).toBe("main-window-form");
    expect(getWindowRouteMapping("/screenshot")?.replacement).toBe("unsupported");
    expect(getWindowRouteMapping("/screenshot-pin")?.replacement).toBe("unsupported");
  });

  it("ignores query, hash, and a trailing slash", () => {
    expect(getWindowRouteMapping("/editor-window?session=abc")?.route).toBe("/editor-window");
    expect(getWindowRouteMapping("/print#top")?.route).toBe("/print");
    expect(getWindowRouteMapping("/screenshot/")?.route).toBe("/screenshot");
  });

  it("returns null for ordinary app routes", () => {
    expect(getWindowRouteMapping("/core/main")).toBeNull();
    expect(getWindowRouteMapping("/")).toBeNull();
    expect(getWindowRouteMapping("")).toBeNull();
  });
});

describe("buildBrowserTabUrlForWindowRoute", () => {
  it("duplicates the current tab for the editor window route", () => {
    expect(buildBrowserTabUrlForWindowRoute("/editor-window", "https://example.test/core/main")).toBe(
      "https://example.test/core/main",
    );
  });

  it("returns null for routes without a browser-tab replacement", () => {
    expect(buildBrowserTabUrlForWindowRoute("/print", "https://example.test/")).toBeNull();
    expect(buildBrowserTabUrlForWindowRoute("/screenshot", "https://example.test/")).toBeNull();
    expect(buildBrowserTabUrlForWindowRoute("/core/main", "https://example.test/")).toBeNull();
  });

  it("returns null when there is no current URL", () => {
    expect(buildBrowserTabUrlForWindowRoute("/editor-window", "")).toBeNull();
  });
});

describe("openWindowRouteInBrowserTab", () => {
  it("returns false without a window object", () => {
    expect(openWindowRouteInBrowserTab("/editor-window")).toBe(false);
  });
});
