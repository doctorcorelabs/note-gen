// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Shortcut parsing, canonicalization, key matching, and the browser
 * conflict tables for the ShortcutAdapter (V2-13).
 *
 * The 8 high-risk combos and the browser actions below come from audit
 * V1-13 (fase1/audit-editor-web.md section 5.2). That audit states plainly
 * that the risk ratings are STATIC PREDICTIONS from common browser
 * defaults, NOT test results. Every row still needs the browser probe
 * matrix in audit section 5.5 before it can be called verified. This file
 * encodes the predictions as refusal defaults so the app never steals a
 * browser-reserved combo by accident; it does not claim the predictions
 * were tested.
 */

import type { ShortcutConflict } from "./interface";

export interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** Normalized key: single characters uppercased, named keys in canonical form. */
  key: string;
}

const NAMED_KEYS: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  return: "Enter",
  enter: "Enter",
  space: "Space",
  spacebar: "Space",
  backspace: "Backspace",
  backsp: "Backspace",
  del: "Delete",
  delete: "Delete",
  tab: "Tab",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pgup: "PageUp",
  pagedown: "PageDown",
  pgdn: "PageDown",
  capslock: "CapsLock",
  numlock: "NumLock",
  scrolllock: "ScrollLock",
  insert: "Insert",
  pause: "Pause",
  printscreen: "PrintScreen",
};

export function normalizeKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed === "") return "";
  if (trimmed === " ") return "Space";
  const lower = trimmed.toLowerCase();
  if (NAMED_KEYS[lower] !== undefined) return NAMED_KEYS[lower];
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  if (trimmed.length === 1) return trimmed.toUpperCase();
  return trimmed;
}

/**
 * Parse a shortcut string into modifiers plus one key. Returns null when
 * the string is empty, has no key, has an unknown token, or has more than
 * one non-modifier token.
 */
export function parseShortcut(shortcut: string): ParsedShortcut | null {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return null;

  const parsed: ParsedShortcut = {
    mod: false,
    ctrl: false,
    meta: false,
    shift: false,
    alt: false,
    key: "",
  };
  let keyCount = 0;

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "mod" || lower === "commandorcontrol" || lower === "cmdorctrl") {
      parsed.mod = true;
    } else if (lower === "ctrl" || lower === "control") {
      parsed.ctrl = true;
    } else if (
      lower === "meta" ||
      lower === "cmd" ||
      lower === "command" ||
      lower === "super" ||
      lower === "win" ||
      lower === "windows"
    ) {
      parsed.meta = true;
    } else if (lower === "shift") {
      parsed.shift = true;
    } else if (lower === "alt" || lower === "option") {
      parsed.alt = true;
    } else {
      keyCount += 1;
      if (keyCount > 1) return null;
      parsed.key = normalizeKey(part);
    }
  }

  if (parsed.key === "") return null;
  return parsed;
}

export function canonicalShortcut(parsed: ParsedShortcut): string {
  const parts: string[] = [];
  if (parsed.mod) parts.push("Mod");
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("Meta");
  if (parsed.shift) parts.push("Shift");
  if (parsed.alt) parts.push("Alt");
  parts.push(parsed.key);
  return parts.join("+");
}

export function canonicalizeShortcut(shortcut: string): string | null {
  const parsed = parseShortcut(shortcut);
  return parsed === null ? null : canonicalShortcut(parsed);
}

export interface BrowserReservedEntry {
  /** Canonical combo form. */
  shortcut: string;
  browserAction: string;
  detail: string;
}

/**
 * Combos the browser reliably intercepts. The web adapter ALWAYS refuses
 * these, even with `allowBrowserConflict`. Rationale per row is the
 * browser default action; none of these were probe-tested by this worker.
 */
export const BROWSER_BLOCKED_SHORTCUTS: readonly BrowserReservedEntry[] = [
  {
    shortcut: "Mod+Shift+W",
    browserAction: "Closes the browser window or tab",
    detail: "Chrome, Edge, and Firefox close the window or tab; the page cannot reliably override it. Also the desktop default for global openWindow.",
  },
  {
    shortcut: "Mod+Shift+T",
    browserAction: "Reopens the last closed tab",
    detail: "Chrome, Edge, and Firefox reopen the last closed tab. Also the desktop default for global quickRecordText.",
  },
  {
    shortcut: "Mod+Shift+N",
    browserAction: "Opens a new private or incognito window",
    detail: "Chrome, Edge, and Firefox open a private window; the page never receives the combo reliably.",
  },
  {
    shortcut: "Mod+W",
    browserAction: "Closes the current tab",
    detail: "Chrome, Edge, and Firefox close the tab; the page cannot reliably override it.",
  },
  {
    shortcut: "Mod+T",
    browserAction: "Opens a new tab",
    detail: "Chrome, Edge, and Firefox open a new tab; the page never receives the combo reliably.",
  },
  {
    shortcut: "Mod+N",
    browserAction: "Opens a new browser window",
    detail: "Chrome, Edge, and Firefox open a new window; the page never receives the combo reliably.",
  },
  {
    shortcut: "Mod+Shift+I",
    browserAction: "Opens DevTools",
    detail: "Chrome, Edge, and Firefox open DevTools; the browser may not deliver the event to the page. Also the editor default for insertImage.",
  },
  {
    shortcut: "Mod+Shift+J",
    browserAction: "Opens the DevTools console",
    detail: "Chrome and Edge open the DevTools console; the browser may not deliver the event to the page. Also the editor default for aiContinue.",
  },
  {
    shortcut: "Mod+Shift+C",
    browserAction: "Opens DevTools inspect element",
    detail: "Chrome, Edge, and Firefox open DevTools inspect mode; the browser may not deliver the event to the page.",
  },
  {
    shortcut: "F12",
    browserAction: "Opens DevTools",
    detail: "Chrome, Edge, and Firefox open DevTools even when the page handles the key; the page must not claim it.",
  },
];

export interface BrowserHighRiskEntry {
  /** Editor shortcut id from src/config/editor-shortcuts.ts (audit V1-13). */
  editorId: string;
  /** Canonical combo form. */
  shortcut: string;
  browserAction: string;
  /** True when the combo is also on the blocked list (DevTools combos). */
  blocked: boolean;
}

/**
 * The 8 HIGH-risk editor combos from audit V1-13 section 5.2 (of 51 editor
 * definitions: 40 bound by default, 11 unbound). The 6 non-blocked rows are
 * refused by default and need an explicit `allowBrowserConflict` opt-in
 * backed by probe evidence. The 2 blocked rows are never allowed.
 */
export const BROWSER_HIGH_RISK_SHORTCUTS: readonly BrowserHighRiskEntry[] = [
  {
    editorId: "toggleOutline",
    shortcut: "Mod+Shift+O",
    browserAction: "Chrome on Windows/Linux opens the Bookmark Manager",
    blocked: false,
  },
  {
    editorId: "toggleUnderline",
    shortcut: "Mod+U",
    browserAction: "Chrome and Firefox show view-source",
    blocked: false,
  },
  {
    editorId: "toggleInlineCode",
    shortcut: "Mod+E",
    browserAction: "Chrome focuses the omnibox or search",
    blocked: false,
  },
  {
    editorId: "openLinkInput",
    shortcut: "Mod+K",
    browserAction: "Chrome and Firefox focus the address bar or search",
    blocked: false,
  },
  {
    editorId: "toggleBlockquote",
    shortcut: "Mod+Shift+B",
    browserAction: "Chrome toggles the bookmarks bar",
    blocked: false,
  },
  {
    editorId: "openAiMenu",
    shortcut: "Mod+J",
    browserAction: "Chrome opens the Downloads page",
    blocked: false,
  },
  {
    editorId: "aiContinue",
    shortcut: "Mod+Shift+J",
    browserAction: "Chrome opens the DevTools console; the browser may not deliver the event to the page",
    blocked: true,
  },
  {
    editorId: "insertImage",
    shortcut: "Mod+Shift+I",
    browserAction: "Chrome and Firefox open DevTools; the browser may not deliver the event to the page",
    blocked: true,
  },
];

/** The 3 desktop global shortcuts from src/stores/shortcut.ts. None has a web equivalent. */
export const DESKTOP_GLOBAL_SHORTCUTS: readonly { key: string; value: string; note: string }[] = [
  {
    key: "openWindow",
    value: "CommandOrControl+Shift+W",
    note: "Global OS-level shortcut. Lost on the web; Mod+Shift+W is browser-reserved (closes the window or tab).",
  },
  {
    key: "screenshotRecord",
    value: "CommandOrControl+Shift+S",
    note: "Global OS-level shortcut. Lost on the web; native screenshot and OCR have no browser equivalent.",
  },
  {
    key: "quickRecordText",
    value: "CommandOrControl+Shift+T",
    note: "Global OS-level shortcut. Lost on the web; Mod+Shift+T is browser-reserved (reopens the last closed tab). Replaced by an in-app quick record form.",
  },
];

/**
 * Check a canonical combo against the browser tables. Returns null when the
 * combo is on neither table. Blocked rows always report `blocking: true`.
 */
export function checkBrowserConflict(canonical: string): ShortcutConflict | null {
  const blocked = BROWSER_BLOCKED_SHORTCUTS.find((entry) => entry.shortcut === canonical);
  if (blocked !== undefined) {
    return {
      kind: "browser-reserved",
      shortcut: canonical,
      browserAction: blocked.browserAction,
      detail: `${blocked.browserAction}. ${blocked.detail}`,
      blocking: true,
    };
  }
  const highRisk = BROWSER_HIGH_RISK_SHORTCUTS.find((entry) => entry.shortcut === canonical);
  if (highRisk !== undefined) {
    return {
      kind: "browser-high-risk",
      shortcut: canonical,
      browserAction: highRisk.browserAction,
      detail: `Editor shortcut ${highRisk.editorId} (${canonical}) conflicts with a browser default: ${highRisk.browserAction}. Predicted HIGH risk by audit V1-13; browser probe evidence is required before overriding.`,
      blocking: true,
    };
  }
  return null;
}

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * True when a key event matches a parsed combo exactly: all required
 * modifiers present, no extra modifiers. `Mod` matches Cmd on macOS and
 * Ctrl elsewhere.
 */
export function matchesKeyEvent(parsed: ParsedShortcut, event: KeyEventLike, isMac: boolean): boolean {
  const wantCtrl = parsed.ctrl || (!isMac && parsed.mod);
  const wantMeta = parsed.meta || (isMac && parsed.mod);
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.metaKey !== wantMeta) return false;
  if (event.shiftKey !== parsed.shift) return false;
  if (event.altKey !== parsed.alt) return false;
  return normalizeKey(event.key) === parsed.key;
}

export function detectMac(): boolean {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  if (nav === undefined) return false;
  if (typeof nav.platform === "string" && nav.platform.length > 0) {
    return nav.platform.toLowerCase().startsWith("mac");
  }
  if (typeof nav.userAgent === "string") {
    return nav.userAgent.includes("Macintosh") || nav.userAgent.includes("Mac OS");
  }
  return false;
}
