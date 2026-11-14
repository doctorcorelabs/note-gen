// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Boot stubs: safe local stand-ins for four commands that run during
 * app boot without guards. Each stub reproduces exactly the desktop
 * behavior for the empty or switched-off case, ignores all arguments,
 * never throws, never sends HTTP, and has no side effects of any kind.
 *
 * Return values are binding:
 * - drain_pending_plugin_install_requests returns []
 * - drain_pending_open_files returns []
 * - list_ocr_providers returns []
 * - track_analytics_event returns ""
 *
 * The OCR stub returns an empty list typed as unknown[] here on
 * purpose: the provider record type lives outside the platform layer,
 * and the empty list carries no elements, so no coupling is needed.
 * Telemetry stays off: the analytics stub never contacts any vendor
 * and never stores the event it is given.
 */

export const BOOT_STUB_COMMANDS: readonly string[] = Object.freeze([
  "drain_pending_plugin_install_requests",
  "drain_pending_open_files",
  "list_ocr_providers",
  "track_analytics_event",
]);

function emptyListStub(): unknown[] {
  return [];
}

function emptyStringStub(): string {
  return "";
}

export const BOOT_STUBS: ReadonlyMap<string, () => unknown> = new Map([
  ["drain_pending_plugin_install_requests", emptyListStub],
  ["drain_pending_open_files", emptyListStub],
  ["list_ocr_providers", emptyListStub],
  ["track_analytics_event", emptyStringStub],
]);

export function isBootStubCommand(command: string): boolean {
  return BOOT_STUBS.has(command);
}

/**
 * Storefront stub, separate from the four boot stubs. The design step 1
 * requires it alongside the boot stubs because its caller sits on the
 * provider-policy path that can run during settings boot. It returns
 * null, which the caller already handles with a locale fallback. It
 * never sends HTTP and has no side effects. There is no app store in
 * the web version, so null is the honest value, not a placeholder.
 */
export const STOREFRONT_STUB_COMMAND = "get_app_storefront_country_code";

export function storefrontStub(): null {
  return null;
}

export function isStorefrontStubCommand(command: string): boolean {
  return command === STOREFRONT_STUB_COMMAND;
}
