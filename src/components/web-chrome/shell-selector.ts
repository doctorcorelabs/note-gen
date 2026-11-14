// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Viewport-based shell selection for the web fork.
 *
 * The MVP keeps two shells: the wide shell under /core and the narrow
 * shell under /mobile (design/11-ui-i18n.md sections 3.1 and 3.2). This
 * module decides which shell an entry load belongs to. It is pure logic
 * with no React and no navigation: the entry page (or the boot guard)
 * reads the decision once at load time and performs the redirect. It
 * never re-runs on resize, so a desktop window narrowed after load
 * stays in the desktop shell, matching the design consequence in
 * section 3.2. There is no tablet shell.
 *
 * Decision rule, in order:
 *
 * 1. An explicit stored preference wins over the viewport.
 * 2. Otherwise the viewport decides: below 768px is the mobile shell,
 *    768px and above is the core shell. 768 is the same breakpoint
 *    useIsMobile uses (MOBILE_BREAKPOINT in src/hooks/use-mobile.tsx);
 *    that constant is module-private, so the value is mirrored here
 *    and the mirror is called out so a future breakpoint change updates
 *    both places. The top app bar and the adaptive dialog already use
 *    useIsMobile, so all three chrome decisions share one breakpoint.
 *
 * The stored preference uses localStorage, the lightweight web storage
 * the design names for this choice. No settings control writes it in
 * Phase 1; wave 3 owns the preference UI. Until then the preference
 * can only be set programmatically, and every entry load without one
 * follows the viewport. Route mapping (which default route each shell
 * opens, legacy path rewrites) stays with the boot guard in
 * src/lib/web/boot-guard.ts; this module returns a shell id only.
 *
 * Wiring note for the integrator: the boot guard currently receives
 * its mobile decision from isMobileDevice(), which is platform and
 * user-agent based. The web-mode follow-up passes
 * resolveEntryShell(window.innerWidth) === 'mobile' instead. This
 * module deliberately does not edit the entry page or the boot guard;
 * both belong to the boot guard owner (V2-08).
 */

export type WebShellId = 'core' | 'mobile'

export type WebShellPreference = 'auto' | WebShellId

/** Viewport width in CSS pixels at and above which the core shell is used. */
export const WEB_SHELL_BREAKPOINT_PX = 768

/** localStorage key for the explicit shell preference. Absence means 'auto'. */
export const WEB_SHELL_PREFERENCE_KEY = 'notegen-web-shell'

/** Storage surface this module needs, kept narrow so tests can pass a fake. */
export type ShellPreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * Parse a stored preference value. Anything unrecognized means 'auto',
 * so a corrupt or foreign value can never strand the user in the wrong
 * shell. Pure function: safe to unit test without a DOM.
 */
export function parseShellPreference(value: unknown): WebShellPreference {
  if (value === 'core' || value === 'mobile' || value === 'auto') return value
  return 'auto'
}

/**
 * Decide the shell for one entry load. An explicit preference wins;
 * otherwise the viewport width decides. A width that is not a finite
 * number (no window, hidden frame) resolves to the core shell, matching
 * the desktop default useIsMobile renders on the server.
 */
export function resolveWebShell(
  widthPx: number,
  preference: WebShellPreference = 'auto',
): WebShellId {
  if (preference === 'core' || preference === 'mobile') return preference
  if (Number.isFinite(widthPx) && widthPx < WEB_SHELL_BREAKPOINT_PX) return 'mobile'
  return 'core'
}

function defaultPreferenceStorage(): ShellPreferenceStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Read the stored shell preference. Returns 'auto' when storage is
 * unavailable, unreadable, or holds an unrecognized value. Never throws.
 */
export function readShellPreference(
  storage: ShellPreferenceStorage | null = defaultPreferenceStorage(),
): WebShellPreference {
  if (!storage) return 'auto'
  try {
    return parseShellPreference(storage.getItem(WEB_SHELL_PREFERENCE_KEY))
  } catch {
    return 'auto'
  }
}

/**
 * Store a shell preference. Writing 'auto' removes the key so absence
 * keeps meaning 'auto'. Failures (blocked storage, quota) are silent
 * by design: the preference is a convenience, never a boot blocker.
 * Never throws.
 */
export function writeShellPreference(
  preference: WebShellPreference,
  storage: ShellPreferenceStorage | null = defaultPreferenceStorage(),
): void {
  if (!storage) return
  try {
    if (preference === 'auto') {
      storage.removeItem(WEB_SHELL_PREFERENCE_KEY)
    } else {
      storage.setItem(WEB_SHELL_PREFERENCE_KEY, preference)
    }
  } catch {
    return
  }
}

/**
 * One-call entry decision: read the stored preference, then resolve
 * the shell for the given viewport width. This is the function the
 * entry page or boot guard calls once at load time.
 */
export function resolveEntryShell(
  widthPx: number,
  storage: ShellPreferenceStorage | null = defaultPreferenceStorage(),
): WebShellId {
  return resolveWebShell(widthPx, readShellPreference(storage))
}
