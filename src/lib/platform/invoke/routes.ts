// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import type { BackendRoute } from "./interface";

/**
 * Backend route table: the single source of truth that maps a BACKEND
 * command name to its dedicated HTTP endpoint.
 *
 * Source: the invoke router design, Table A (56 BACKEND annotations,
 * 56 unique names). Endpoint paths are design proposals pending
 * confirmation by the backend design; if the backend adopts a uniform
 * version prefix, every path shifts uniformly without changing the
 * command-to-resource mapping.
 *
 * This table is routing data only. It does not mean an endpoint exists:
 * no route is callable until a later wave implements the backend
 * endpoint, supplies a transport, and marks the route available. Until
 * then the web adapter rejects every entry here locally with an
 * explicit not-implemented error and sends no HTTP.
 *
 * Aliases share one path on purpose: fuzzy search names share the
 * search endpoint, restore names share the restore endpoint, and skill
 * import names share the import endpoint. The server never needs to
 * know which alias the caller used.
 */

/** Command name for the reserved AI chat stream (BACKEND, phase 2). */
export const AI_CHAT_STREAM_COMMAND = "ai_chat_completion_stream";

export const BACKEND_ROUTES: readonly BackendRoute[] = Object.freeze([
  // AI transport (phase 2). Keys stay server-side; see the AI design.
  { command: "ai_json_request", method: "POST", path: "/api/ai/json", group: "ai", phase: "2" },
  { command: "ai_binary_request", method: "POST", path: "/api/ai/binary", group: "ai", phase: "2" },
  { command: "ai_multipart_request", method: "POST", path: "/api/ai/multipart", group: "ai", phase: "2" },
  {
    command: AI_CHAT_STREAM_COMMAND,
    method: "POST",
    path: "/api/ai/chat/stream",
    group: "ai",
    phase: "2",
    stream: true,
  },
  {
    command: "cancel_ai_request",
    method: "POST",
    path: "/api/ai/requests/{requestId}/cancel",
    group: "ai",
    phase: "2",
  },

  // Backup and restore (phase 1 for create, list, and export).
  { command: "create_managed_backup", method: "POST", path: "/api/backups", group: "backups", phase: "1" },
  { command: "list_managed_backups", method: "GET", path: "/api/backups", group: "backups", phase: "1" },
  { command: "export_app_data", method: "GET", path: "/api/backups/export", group: "backups", phase: "1" },
  { command: "restore_managed_backup", method: "POST", path: "/api/backups/restore", group: "backups", phase: "2" },
  { command: "import_app_data_from_file", method: "POST", path: "/api/backups/restore", group: "backups", phase: "2" },
  { command: "import_app_data", method: "POST", path: "/api/backups/restore", group: "backups", phase: "2" },

  // Documents. Phase 2 or 3e is still open (triage doubt R4); routed
  // here as a phase 2 reservation until that decision lands.
  { command: "parse_document", method: "POST", path: "/api/documents/parse", group: "documents", phase: "2" },

  // Fuzzy search (phase 2). Both names are one endpoint by design.
  { command: "fuzzy_search", method: "POST", path: "/api/search/fuzzy", group: "search", phase: "2" },
  { command: "fuzzy_search_parallel", method: "POST", path: "/api/search/fuzzy", group: "search", phase: "2" },

  // Notion import (phase 3e).
  { command: "import_notion_zip", method: "POST", path: "/api/imports/notion", group: "imports", phase: "3e" },

  // Plugin host and installation (phase 3b).
  { command: "plugin_read_host_state", method: "GET", path: "/api/plugins/host-state", group: "plugins", phase: "3b" },
  { command: "plugin_commit_host_state", method: "PUT", path: "/api/plugins/host-state", group: "plugins", phase: "3b" },
  { command: "plugin_list_installed", method: "GET", path: "/api/plugins/installed", group: "plugins", phase: "3b" },
  { command: "plugin_import_local", method: "POST", path: "/api/plugins/import", group: "plugins", phase: "3b" },
  {
    command: "plugin_rollback",
    method: "POST",
    path: "/api/plugins/{pluginId}/rollback",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_confirm_activation",
    method: "POST",
    path: "/api/plugins/{pluginId}/confirm-activation",
    group: "plugins",
    phase: "3b",
  },
  { command: "plugin_uninstall", method: "DELETE", path: "/api/plugins/{pluginId}", group: "plugins", phase: "3b" },

  // Plugin packages (phase 3b).
  { command: "plugin_read_entry", method: "GET", path: "/api/plugins/{pluginId}/entry", group: "plugins", phase: "3b" },
  { command: "plugin_read_locale", method: "GET", path: "/api/plugins/{pluginId}/locale", group: "plugins", phase: "3b" },
  { command: "plugin_read_usage", method: "GET", path: "/api/plugins/{pluginId}/usage", group: "plugins", phase: "3b" },
  {
    command: "plugin_read_resource",
    method: "GET",
    path: "/api/plugins/{pluginId}/resources",
    group: "plugins",
    phase: "3b",
  },

  // Plugin storage (phase 3b).
  {
    command: "plugin_storage_get",
    method: "GET",
    path: "/api/plugins/{pluginId}/storage/{key}",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_storage_set",
    method: "PUT",
    path: "/api/plugins/{pluginId}/storage/{key}",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_storage_remove",
    method: "DELETE",
    path: "/api/plugins/{pluginId}/storage/{key}",
    group: "plugins",
    phase: "3b",
  },

  // Plugin workspace (phase 3b).
  {
    command: "plugin_read_attachment",
    method: "GET",
    path: "/api/plugins/workspace/attachments",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_create_attachment",
    method: "POST",
    path: "/api/plugins/workspace/attachments",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_open_or_create_note",
    method: "POST",
    path: "/api/plugins/workspace/notes/open-or-create",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_read_workspace_note",
    method: "GET",
    path: "/api/plugins/workspace/notes",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_list_workspace_notes",
    method: "GET",
    path: "/api/plugins/workspace/notes/list",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_write_workspace_note",
    method: "PUT",
    path: "/api/plugins/workspace/notes",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_delete_workspace_note",
    method: "DELETE",
    path: "/api/plugins/workspace/notes",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_move_workspace_note",
    method: "POST",
    path: "/api/plugins/workspace/notes/move",
    group: "plugins",
    phase: "3b",
  },
  {
    command: "plugin_read_preview_chunk",
    method: "GET",
    path: "/api/plugins/workspace/notes/preview-chunk",
    group: "plugins",
    phase: "3b",
  },

  // Plugin network (phase 3b).
  { command: "plugin_network_fetch", method: "POST", path: "/api/plugins/network/fetch", group: "plugins", phase: "3b" },

  // Record transactions (phase 1, required). No raw SQL from clients.
  {
    command: "execute_record_transaction",
    method: "POST",
    path: "/api/db/record-transaction",
    group: "db",
    phase: "1",
  },

  // Remote skills (phase 3d).
  { command: "search_remote_skills", method: "GET", path: "/api/skills/remote/search", group: "skills", phase: "3d" },
  { command: "inspect_remote_skill", method: "POST", path: "/api/skills/remote/inspect", group: "skills", phase: "3d" },
  { command: "install_remote_skill", method: "POST", path: "/api/skills/remote/install", group: "skills", phase: "3d" },
  {
    command: "cancel_remote_skill_download",
    method: "POST",
    path: "/api/skills/remote/downloads/{requestId}/cancel",
    group: "skills",
    phase: "3d",
  },

  // Skill packages (phase 3d).
  { command: "uninstall_skill", method: "DELETE", path: "/api/skills/{scope}/{skillId}", group: "skills", phase: "3d" },
  { command: "import_skill", method: "POST", path: "/api/skills/import", group: "skills", phase: "3d" },
  { command: "import_skill_zip", method: "POST", path: "/api/skills/import", group: "skills", phase: "3d" },
  { command: "validate_skill_package", method: "POST", path: "/api/skills/validate", group: "skills", phase: "3d" },
  {
    command: "install_skill_package",
    method: "POST",
    path: "/api/skills/packages/install",
    group: "skills",
    phase: "3d",
  },

  // Trash (phase 1). Workspace-relative paths only.
  { command: "move_paths_to_trash", method: "POST", path: "/api/workspace/trash", group: "workspace", phase: "1" },

  // Clipper (phase 3e, conditional on the clipper service decision).
  {
    command: "approve_web_clipper_pairing",
    method: "POST",
    path: "/api/clipper/pairings/{id}/approve",
    group: "clipper",
    phase: "3e",
  },
  {
    command: "reject_web_clipper_pairing",
    method: "POST",
    path: "/api/clipper/pairings/{id}/reject",
    group: "clipper",
    phase: "3e",
  },
  {
    command: "set_web_clipper_enabled",
    method: "PUT",
    path: "/api/clipper/settings/enabled",
    group: "clipper",
    phase: "3e",
  },
  { command: "get_web_clipper_status", method: "GET", path: "/api/clipper/status", group: "clipper", phase: "3e" },
  { command: "list_web_clipper_connections", method: "GET", path: "/api/clipper/connections", group: "clipper", phase: "3e" },
  {
    command: "revoke_web_clipper_connection",
    method: "DELETE",
    path: "/api/clipper/connections/{id}",
    group: "clipper",
    phase: "3e",
  },
]);

const BACKEND_ROUTES_BY_COMMAND: ReadonlyMap<string, BackendRoute> = new Map(
  BACKEND_ROUTES.map((route) => [route.command, route]),
);

export function getBackendRoute(command: string): BackendRoute | undefined {
  return BACKEND_ROUTES_BY_COMMAND.get(command);
}

export function isBackendCommand(command: string): boolean {
  return BACKEND_ROUTES_BY_COMMAND.has(command);
}
