// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { capabilityError, type PlatformCapabilityError } from "../errors";
import type { BackendRoute } from "./router";

/**
 * Explicit rejections for the web invoke router.
 *
 * Every rejection is a PlatformCapabilityError built with the shared
 * framework helper. The adapter name is "invoke" and the capability
 * holds the command name, so the composed message reads as
 * "invoke.<command> is not available in web mode". No rejection sends
 * HTTP, and no rejection forwards raw server text to the caller.
 *
 * Error code mapping (framework vocabulary is binding in this wave;
 * the design document uses a wider code set that the framework error
 * type does not have yet):
 * - unknown or disabled command, default path: "unavailable"
 *   (design codes CAPABILITY_UNAVAILABLE and UNKNOWN_COMMAND)
 * - gated command, decided later: "unsupported"
 *   (design code CAPABILITY_GATED; no gated code exists in the
 *   framework type yet, so "unsupported" is the closest fit)
 * - backend route with no handler yet: "not_implemented" (HTTP 501)
 *   (design code FEATURE_NOT_YET_AVAILABLE)
 * - stream request in the MVP: "not_implemented" (SSE not available)
 * - invalid arguments: "invalid_argument"
 *   (design code VALIDATION_ERROR)
 * - HTTP 401 or 403: "permission_denied" (design code AUTH_REQUIRED
 *   for 401; the framework has no separate auth code)
 * - HTTP 410: "unavailable"; other backend failures: "backend_error"
 *
 * Message keys below are PROPOSALS ONLY. They do not exist in the
 * message files yet, and the key registry belongs to a later wave.
 * This module is the single place to update when the registry lands:
 * the resolver maps a rejection to its proposed key, and the error
 * reason carries the English fallback text for logs. UI text must
 * come from the key, never from the reason string.
 */

const ADAPTER_NAME = "invoke";

export const PROPOSED_MESSAGE_KEYS: Readonly<Record<string, string>> =
  Object.freeze({
    generic: "platform.unavailable.generic",
    browserPanel: "platform.unavailable.browserPanel",
    screenshot: "platform.unavailable.screenshot",
    deviceFolder: "platform.unavailable.deviceFolder",
    deviceSecureStorage: "platform.unavailable.deviceSecureStorage",
    localServer: "platform.unavailable.localServer",
    localProcess: "platform.unavailable.localProcess",
    osWindow: "platform.unavailable.osWindow",
    osPermission: "platform.unavailable.osPermission",
    systemInfo: "platform.unavailable.systemInfo",
    pluginMarket: "platform.unavailable.pluginMarket",
    desktopOnly: "platform.unavailable.desktopOnly",
    clipboardFormat: "platform.unavailable.clipboardFormat",
    backendNotYet: "platform.notYetAvailable.backend",
    aiStreamNotYet: "platform.notYetAvailable.aiStream",
    gatedSelfHosted: "platform.gated.selfHosted",
    gatedSkillRuntime: "platform.gated.skillRuntime",
    gatedFeature: "platform.gated.feature",
  });

export const PROPOSED_MESSAGE_TEXTS: Readonly<Record<string, string>> =
  Object.freeze({
    [PROPOSED_MESSAGE_KEYS.generic]:
      "This feature is not available in the web version.",
    [PROPOSED_MESSAGE_KEYS.browserPanel]:
      "The in-app browser panel is not available in the web version. Open the link in a new browser tab instead.",
    [PROPOSED_MESSAGE_KEYS.screenshot]:
      "Screenshots cannot be captured from the web version. Upload or paste an image instead.",
    [PROPOSED_MESSAGE_KEYS.deviceFolder]:
      "Device folders are not available in the web version. Your workspace lives on the server.",
    [PROPOSED_MESSAGE_KEYS.deviceSecureStorage]:
      "This device-only storage is not available in the web version.",
    [PROPOSED_MESSAGE_KEYS.localServer]:
      "The local server for this feature is not available in the web version.",
    [PROPOSED_MESSAGE_KEYS.localProcess]:
      "This feature needs a local process and cannot run in the web version.",
    [PROPOSED_MESSAGE_KEYS.osWindow]:
      "Desktop windows and system bars are not available in the web version.",
    [PROPOSED_MESSAGE_KEYS.osPermission]:
      "System permissions cannot be managed from the web version. Use your browser permission prompt instead.",
    [PROPOSED_MESSAGE_KEYS.systemInfo]:
      "System information is not available in the web version.",
    [PROPOSED_MESSAGE_KEYS.pluginMarket]:
      "The plugin marketplace is not available in the web version.",
    [PROPOSED_MESSAGE_KEYS.desktopOnly]:
      "This desktop-only feature is not available in the web version.",
    [PROPOSED_MESSAGE_KEYS.clipboardFormat]:
      "This clipboard format is not supported in the web version.",
    [PROPOSED_MESSAGE_KEYS.backendNotYet]:
      "This feature is not available yet in this version.",
    [PROPOSED_MESSAGE_KEYS.aiStreamNotYet]:
      "AI streaming is not available yet in this version.",
    [PROPOSED_MESSAGE_KEYS.gatedSelfHosted]:
      "Self-hosted sync is turned off in this version.",
    [PROPOSED_MESSAGE_KEYS.gatedSkillRuntime]:
      "Skill scripts are turned off in this version.",
    [PROPOSED_MESSAGE_KEYS.gatedFeature]:
      "This feature is turned off in this version.",
  });

/**
 * Caller-backed disabled commands (87 of the 91 names with a frontend
 * caller) mapped to their message family. The four remaining
 * caller-backed names stay unnamed on purpose: they are covered by
 * the AD-14 ban, must never appear in source, and are rejected by the
 * default path with the generic key. Disabled names without a caller
 * are likewise unnamed and rejected by the default path. Any command
 * not listed here falls through to the generic key, so the default
 * path stays correct even if this table misses a name.
 *
 * Counts: 12 Android + 12 browser + 7 folder sync + 6 iOS + 14 other
 * + 7 local MCP + 7 MCP stdio and runtime + 3 market + 17 screenshot
 * + 2 clipper bridge = 87.
 */
export const DISABLED_MESSAGE_KEYS: ReadonlyMap<string, string> = new Map([
  // Android folder and secure values (12).
  ["set_android_secure_value", PROPOSED_MESSAGE_KEYS.deviceSecureStorage],
  ["get_android_secure_value", PROPOSED_MESSAGE_KEYS.deviceSecureStorage],
  ["delete_android_secure_value", PROPOSED_MESSAGE_KEYS.deviceSecureStorage],
  ["pick_android_sync_folder", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["release_android_sync_folder", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["snapshot_android_cloud_folder_path", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["move_android_cloud_folder_path", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["test_android_cloud_folder", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["write_android_cloud_folder_file", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["read_android_cloud_folder_file", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["delete_android_cloud_folder_file", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["list_android_cloud_folder_files", PROPOSED_MESSAGE_KEYS.deviceFolder],
  // In-app browser (12).
  ["browser_create", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_set_bounds", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_set_visible", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_snapshot", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_navigate", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_history", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_history_state", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_reload", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_get_url", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_close", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_set_theme", PROPOSED_MESSAGE_KEYS.browserPanel],
  ["browser_get_content", PROPOSED_MESSAGE_KEYS.browserPanel],
  // Folder sync (7).
  ["get_icloud_sync_folder", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["test_cloud_folder_sync", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["write_cloud_folder_sync_file", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["read_cloud_folder_sync_file", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["delete_cloud_folder_sync_file", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["list_cloud_folder_sync_files", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["migrate_workspace_to_cloud_folder", PROPOSED_MESSAGE_KEYS.deviceFolder],
  // iOS folder and secure values (6).
  ["pick_ios_sync_folder", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["restore_ios_sync_folder", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["release_ios_sync_folder", PROPOSED_MESSAGE_KEYS.deviceFolder],
  ["set_ios_secure_value", PROPOSED_MESSAGE_KEYS.deviceSecureStorage],
  ["get_ios_secure_value", PROPOSED_MESSAGE_KEYS.deviceSecureStorage],
  ["delete_ios_secure_value", PROPOSED_MESSAGE_KEYS.deviceSecureStorage],
  // Other caller-backed commands (14).
  ["delete_local_database", PROPOSED_MESSAGE_KEYS.desktopOnly],
  ["list_system_fonts", PROPOSED_MESSAGE_KEYS.systemInfo],
  ["open_developer_tools", PROPOSED_MESSAGE_KEYS.desktopOnly],
  ["close_developer_tools", PROPOSED_MESSAGE_KEYS.desktopOnly],
  ["is_developer_tools_open", PROPOSED_MESSAGE_KEYS.desktopOnly],
  ["get_desktop_update_target", PROPOSED_MESSAGE_KEYS.desktopOnly],
  ["microsoft_oauth_request", PROPOSED_MESSAGE_KEYS.generic],
  ["set_mobile_system_bars", PROPOSED_MESSAGE_KEYS.osWindow],
  ["run_ocr_provider", PROPOSED_MESSAGE_KEYS.desktopOnly],
  ["update_tray_record_toolbar_config", PROPOSED_MESSAGE_KEYS.osWindow],
  ["get_system_media_permissions", PROPOSED_MESSAGE_KEYS.osPermission],
  ["request_screen_capture_permission", PROPOSED_MESSAGE_KEYS.osPermission],
  ["remember_quick_record_foreground", PROPOSED_MESSAGE_KEYS.osWindow],
  ["hide_quick_record_window", PROPOSED_MESSAGE_KEYS.osWindow],
  // Local MCP server (7 with callers).
  ["set_local_mcp_ready", PROPOSED_MESSAGE_KEYS.localServer],
  ["set_local_mcp_enabled", PROPOSED_MESSAGE_KEYS.localServer],
  ["get_local_mcp_status", PROPOSED_MESSAGE_KEYS.localServer],
  ["set_local_mcp_port", PROPOSED_MESSAGE_KEYS.localServer],
  ["get_or_create_local_mcp_connection", PROPOSED_MESSAGE_KEYS.localServer],
  ["reset_local_mcp_access_token", PROPOSED_MESSAGE_KEYS.localServer],
  ["resolve_local_mcp_request", PROPOSED_MESSAGE_KEYS.localServer],
  // MCP stdio and runtime (7).
  ["start_mcp_stdio_server", PROPOSED_MESSAGE_KEYS.localProcess],
  ["stop_mcp_server", PROPOSED_MESSAGE_KEYS.localProcess],
  ["send_mcp_message", PROPOSED_MESSAGE_KEYS.localProcess],
  ["send_mcp_notification", PROPOSED_MESSAGE_KEYS.localProcess],
  ["inspect_mcp_runtime", PROPOSED_MESSAGE_KEYS.localProcess],
  ["install_mcp_runtime", PROPOSED_MESSAGE_KEYS.localProcess],
  ["cancel_mcp_runtime_install", PROPOSED_MESSAGE_KEYS.localProcess],
  // Plugin marketplace (3).
  ["plugin_fetch_market", PROPOSED_MESSAGE_KEYS.pluginMarket],
  ["plugin_fetch_market_statistics", PROPOSED_MESSAGE_KEYS.pluginMarket],
  ["plugin_install_market", PROPOSED_MESSAGE_KEYS.pluginMarket],
  // Screenshot and pin (17).
  ["screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["begin_desktop_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["get_desktop_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["ready_desktop_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["set_desktop_screenshot_dialog_mode", PROPOSED_MESSAGE_KEYS.screenshot],
  ["fail_desktop_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["cancel_desktop_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["complete_desktop_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["pin_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["get_pinned_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["read_pinned_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["save_pinned_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["fail_pinned_screenshot_record", PROPOSED_MESSAGE_KEYS.screenshot],
  ["ready_pinned_screenshot", PROPOSED_MESSAGE_KEYS.screenshot],
  ["drain_desktop_screenshot_results", PROPOSED_MESSAGE_KEYS.screenshot],
  ["remove_desktop_screenshot_result", PROPOSED_MESSAGE_KEYS.screenshot],
  ["cleanup_screenshot_cache", PROPOSED_MESSAGE_KEYS.screenshot],
  // Clipper bridge (2).
  ["set_web_clipper_ready", PROPOSED_MESSAGE_KEYS.localServer],
  ["resolve_web_clipper_request", PROPOSED_MESSAGE_KEYS.localServer],
]);

export function isDisabledCommand(command: string): boolean {
  return DISABLED_MESSAGE_KEYS.has(command);
}

/**
 * Gated STUB commands (36): 27 self-hosted names, 7 skill runtime
 * names, plus the development-revision and print singletons. All 36
 * reject locally until their gate or phase design decides otherwise.
 * They move as groups: no gated name is enabled on its own.
 */
const GATED_MESSAGE_KEYS: ReadonlyMap<string, string> = new Map([
  // Self-hosted crypto (11).
  ["self_hosted_generate_workspace_key", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_generate_device_key_pair", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_encrypt", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_encrypt_bytes", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_decrypt", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_decrypt_packed", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_decrypt_packed_bytes", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_sha256", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_derive_argon2id_key", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_wrap_workspace_key", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_unwrap_workspace_key", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  // Self-hosted files (12).
  ["self_hosted_portable_path", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_move_source_path", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_import_object_id", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_structured_object_id", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_atomic_write", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_delete_file", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_create_directory", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_delete_directory", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_move_path", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_flush_switch_data", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_pending_file_journal", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_recover_file_journal", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  // Self-hosted secure storage (4).
  ["self_hosted_secure_set", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_secure_get", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_secure_delete", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  ["self_hosted_secure_retry_access", PROPOSED_MESSAGE_KEYS.gatedSelfHosted],
  // Skill runtime (7).
  ["run_skill_script", PROPOSED_MESSAGE_KEYS.gatedSkillRuntime],
  ["run_skill_code", PROPOSED_MESSAGE_KEYS.gatedSkillRuntime],
  ["inspect_skill_python", PROPOSED_MESSAGE_KEYS.gatedSkillRuntime],
  ["install_skill_python_dependencies", PROPOSED_MESSAGE_KEYS.gatedSkillRuntime],
  ["install_skill_node_dependencies", PROPOSED_MESSAGE_KEYS.gatedSkillRuntime],
  ["inspect_skill_environment", PROPOSED_MESSAGE_KEYS.gatedSkillRuntime],
  ["cancel_skill_script", PROPOSED_MESSAGE_KEYS.gatedSkillRuntime],
  // Singletons decided by a later phase design (2).
  ["plugin_development_revision", PROPOSED_MESSAGE_KEYS.gatedFeature],
  ["print_webview", PROPOSED_MESSAGE_KEYS.gatedFeature],
]);

export function gatedMessageKeyForCommand(command: string): string | undefined {
  return GATED_MESSAGE_KEYS.get(command);
}

export function isGatedCommand(command: string): boolean {
  return GATED_MESSAGE_KEYS.has(command);
}

export type RejectionKind =
  | "default"
  | "gated"
  | "backend-not-implemented"
  | "stream-not-available";

/** Proposed i18n key for a rejection. Pure function, no side effects. */
export function proposedMessageKeyForRejection(
  kind: RejectionKind,
  command?: string,
): string {
  if (kind === "backend-not-implemented") {
    return PROPOSED_MESSAGE_KEYS.backendNotYet;
  }
  if (kind === "stream-not-available") {
    return PROPOSED_MESSAGE_KEYS.aiStreamNotYet;
  }
  if (kind === "gated" && command !== undefined) {
    return (
      gatedMessageKeyForCommand(command) ?? PROPOSED_MESSAGE_KEYS.gatedFeature
    );
  }
  if (command !== undefined) {
    return (
      DISABLED_MESSAGE_KEYS.get(command) ?? PROPOSED_MESSAGE_KEYS.generic
    );
  }
  return PROPOSED_MESSAGE_KEYS.generic;
}

function fallbackTextForKey(messageKey: string): string {
  return (
    PROPOSED_MESSAGE_TEXTS[messageKey] ?? PROPOSED_MESSAGE_TEXTS[PROPOSED_MESSAGE_KEYS.generic] ??
    "This feature is not available in the web version."
  );
}

/**
 * Default rejection for any command with no stub and no backend route.
 * This one path covers disabled commands, typos, and commands that
 * have not been triaged yet. It never sends HTTP.
 */
export function createDefaultRejection(command: string): PlatformCapabilityError {
  const messageKey = proposedMessageKeyForRejection("default", command);
  return capabilityError(
    "unavailable",
    ADAPTER_NAME,
    command,
    "web",
    fallbackTextForKey(messageKey),
  );
}

/**
 * Rejection for a gated command. The feature is switched off in this
 * version, pending a gate decision; the rejection must not promise a
 * date and must not send HTTP or fake a result.
 */
export function createGatedRejection(command: string): PlatformCapabilityError {
  const messageKey = proposedMessageKeyForRejection("gated", command);
  return capabilityError(
    "unsupported",
    ADAPTER_NAME,
    command,
    "web",
    fallbackTextForKey(messageKey),
  );
}

/**
 * Rejection for a registered backend route whose handler does not
 * exist yet. The 501 is explicit in the reason so logs and tests can
 * tell "known route, not built" apart from "unknown command".
 */
export function createBackendNotImplementedRejection(
  route: BackendRoute,
): PlatformCapabilityError {
  const reason =
    `${fallbackTextForKey(PROPOSED_MESSAGE_KEYS.backendNotYet)} ` +
    `(HTTP 501: ${route.method} ${route.path} is not implemented yet.)`;
  return capabilityError(
    "not_implemented",
    ADAPTER_NAME,
    route.command,
    "web",
    reason,
  );
}

/**
 * Rejection for streaming requests in the MVP. The SSE transport is a
 * later-phase reservation; the MVP never opens a stream and never
 * returns an empty iterable in place of an error.
 */
export function createStreamNotAvailableRejection(
  command: string,
  reservedPath?: string,
): PlatformCapabilityError {
  const suffix =
    reservedPath === undefined
      ? "Streaming is not available in this version."
      : `The SSE endpoint ${reservedPath} is reserved for a later phase and is not available in this version.`;
  const reason = `${fallbackTextForKey(PROPOSED_MESSAGE_KEYS.aiStreamNotYet)} ${suffix}`;
  return capabilityError("not_implemented", ADAPTER_NAME, command, "web", reason);
}

export function createInvalidArgsRejection(
  command: string,
  detail: string,
): PlatformCapabilityError {
  const capability = command === "" ? "unknown" : command;
  return capabilityError(
    "invalid_argument",
    ADAPTER_NAME,
    capability,
    "web",
    detail,
  );
}

/** Map an HTTP status to the closest framework error code. */
export function mapHttpStatusToCode(
  status: number,
): "invalid_argument" | "permission_denied" | "unavailable" | "not_implemented" | "backend_error" {
  if (status === 400) {
    return "invalid_argument";
  }
  if (status === 401 || status === 403) {
    return "permission_denied";
  }
  if (status === 410) {
    return "unavailable";
  }
  if (status === 501) {
    return "not_implemented";
  }
  return "backend_error";
}

/**
 * Rejection for a backend error envelope. Only the stable server error
 * code is kept for logs; server message text is never forwarded, so a
 * server detail can never leak into the caller as a user-facing string.
 */
export function createBackendErrorRejection(
  command: string,
  status: number,
  serverCode?: string,
): PlatformCapabilityError {
  const detail =
    serverCode === undefined
      ? `Backend request failed with HTTP ${status}.`
      : `Backend request failed with HTTP ${status} (server code ${serverCode}).`;
  return capabilityError(
    mapHttpStatusToCode(status),
    ADAPTER_NAME,
    command,
    "web",
    detail,
  );
}
