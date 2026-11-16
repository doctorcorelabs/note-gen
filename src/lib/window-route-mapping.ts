// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Mapping of desktop-only window routes to their web replacements
// (Fase 1, V3-24). Source: fase1/audit-editor-web.md section 6.
// Each route that existed only as a Tauri webview window gets one
// explicit replacement, and opening the route URL directly in a
// browser must show an honest marker instead of a blank page. The
// route pages render that marker through the shared notice
// component; this module only decides what each route maps to.
//
// The browser panel (browser-panel.tsx) is not in this table: it
// already has an explicit non-Tauri branch that renders its
// browserUnavailable message, and external links open as ordinary
// browser tabs.
//
// Tab safety: the browser-tab replacement duplicates the current
// tab. There is no per-file deep link in the MVP, so the new tab
// boots the app and the file is reopened from the restored tab
// state. Two tabs editing the same file are guarded by the AD-17
// revision guard (409 plus a three-choice conflict dialog), which
// is a separate feature from this mapping; this module must not
// promise guard behavior in its copy.

import type { SurfacedEditorDisabledFeature } from "./editor-disabled";

/** How a desktop window route is replaced on the web. */
export type WindowRouteReplacement =
  | "browser-tab"
  | "browser-dialog"
  | "main-window-form"
  | "unsupported";

export interface WindowRouteMapping {
  /** The desktop route path, without query or hash. */
  readonly route: string;
  /** What the web version does instead. */
  readonly replacement: WindowRouteReplacement;
  /** Disabled-surface feature whose catalog copy explains the mapping. */
  readonly feature: SurfacedEditorDisabledFeature;
}

export const DESKTOP_WINDOW_ROUTE_MAP: readonly WindowRouteMapping[] = [
  {
    route: "/editor-window",
    replacement: "browser-tab",
    feature: "editorWindow",
  },
  {
    route: "/print",
    replacement: "browser-dialog",
    feature: "printWindow",
  },
  {
    route: "/quick-record",
    replacement: "main-window-form",
    feature: "quickRecordWindow",
  },
  {
    route: "/screenshot",
    replacement: "unsupported",
    feature: "screenshot",
  },
  {
    route: "/screenshot-pin",
    replacement: "unsupported",
    feature: "screenshot",
  },
];

function normalizeWindowRoutePath(pathname: string): string {
  const withoutQuery = pathname.split("?")[0].split("#")[0];
  const trimmed = withoutQuery.trim();
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

/** Mapping for a route path, or null when the route is not a desktop window route. */
export function getWindowRouteMapping(pathname: string): WindowRouteMapping | null {
  const normalized = normalizeWindowRoutePath(pathname);
  return DESKTOP_WINDOW_ROUTE_MAP.find((mapping) => mapping.route === normalized) ?? null;
}

/**
 * URL to open for the browser-tab replacement of a window route,
 * or null when the route has no browser-tab replacement. The
 * editor-window replacement duplicates the current tab URL: the
 * audit replacement is "the editor becomes a browser tab", and
 * no per-file deep link exists in the MVP.
 */
export function buildBrowserTabUrlForWindowRoute(
  pathname: string,
  currentHref: string,
): string | null {
  const mapping = getWindowRouteMapping(pathname);
  if (mapping === null || mapping.replacement !== "browser-tab") return null;
  if (!currentHref) return null;
  return currentHref;
}

/**
 * Open the browser-tab replacement of a window route. Returns
 * false when there is no window (server render), when the route
 * has no browser-tab replacement, or when the browser blocks the
 * new tab. Callers must keep their existing failure handling for
 * the false case and must not claim the tab opened.
 */
export function openWindowRouteInBrowserTab(pathname: string): boolean {
  if (typeof window === "undefined") return false;
  const url = buildBrowserTabUrlForWindowRoute(pathname, window.location.href);
  if (url === null) return false;
  const opened = window.open(url, "_blank", "noopener");
  return opened !== null;
}
