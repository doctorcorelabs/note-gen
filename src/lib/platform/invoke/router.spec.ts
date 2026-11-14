// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the web invoke router, using the repo convention
 * (node:test with node:assert/strict). The repo has no test runner
 * configured, and these TypeScript modules use bundler-style imports
 * that raw node cannot resolve, so run the suite through an esbuild
 * bundle first:
 *
 * ./node_modules/.bin/esbuild src/lib/platform/invoke/router.spec.ts \
 *   --bundle --platform=node --format=esm \
 *   --outfile=/tmp/invoke-router.spec.mjs \
 * && node --test /tmp/invoke-router.spec.mjs
 *
 * No test in this file sends HTTP: there is no transport registered,
 * so every backend assertion about the 501 path also proves that no
 * request left the adapter.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PlatformCapabilityError } from "../errors";
import { createHandlerRegistry } from "./handlers";
import { createWebInvokeAdapter } from "./index";
import {
  DISABLED_MESSAGE_KEYS,
  isGatedCommand,
  proposedMessageKeyForRejection,
  PROPOSED_MESSAGE_KEYS,
} from "./rejections";
import {
  AI_CHAT_STREAM_COMMAND,
  BACKEND_ROUTES,
  getBackendRoute,
} from "./routes";
import { BOOT_STUBS } from "./stubs";
import { WebInvokeAdapter } from "./web";

async function captureRejection(
  promise: Promise<unknown>,
): Promise<PlatformCapabilityError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof PlatformCapabilityError,
      `expected a PlatformCapabilityError, got ${String(error)}`,
    );
    return error;
  }
  assert.fail("expected the promise to reject");
}

test("boot stubs return the exact binding values", async () => {
  const adapter = new WebInvokeAdapter();
  assert.deepEqual(
    await adapter.invoke("drain_pending_plugin_install_requests"),
    [],
  );
  assert.deepEqual(await adapter.invoke("drain_pending_open_files"), []);
  assert.deepEqual(await adapter.invoke("list_ocr_providers"), []);
  assert.equal(await adapter.invoke("track_analytics_event"), "");
  assert.equal(BOOT_STUBS.size, 4);
});

test("boot stubs return fresh arrays and ignore arguments", async () => {
  const adapter = new WebInvokeAdapter();
  const first = await adapter.invoke<unknown[]>("drain_pending_open_files", {
    ignored: true,
  });
  const second = await adapter.invoke<unknown[]>("drain_pending_open_files");
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal(
    await adapter.invoke("track_analytics_event", {
      event: "app_start",
      sessionId: "anything",
    }),
    "",
  );
});

test("storefront stub returns null", async () => {
  const adapter = new WebInvokeAdapter();
  assert.equal(
    await adapter.invoke("get_app_storefront_country_code"),
    null,
  );
});

test("disabled commands reject through the default path", async () => {
  const adapter = new WebInvokeAdapter();
  const sample = [
    "browser_create",
    "browser_get_content",
    "screenshot",
    "pin_screenshot",
    "pick_android_sync_folder",
    "get_icloud_sync_folder",
    "set_android_secure_value",
    "set_local_mcp_ready",
    "set_web_clipper_ready",
    "start_mcp_stdio_server",
    "inspect_mcp_runtime",
    "set_mobile_system_bars",
    "update_tray_record_toolbar_config",
    "get_system_media_permissions",
    "request_screen_capture_permission",
    "list_system_fonts",
    "plugin_fetch_market",
    "plugin_install_market",
    "get_desktop_update_target",
    "run_ocr_provider",
    "delete_local_database",
    "microsoft_oauth_request",
  ];
  for (const command of sample) {
    const error = await captureRejection(adapter.invoke(command));
    assert.equal(error.code, "unavailable");
    assert.equal(error.capability, command);
    assert.equal(error.adapter, "invoke");
    assert.equal(error.mode, "web");
  }
  assert.equal(DISABLED_MESSAGE_KEYS.size, 87);
});

test("unknown commands reject with the generic key", async () => {
  const adapter = new WebInvokeAdapter();
  const error = await captureRejection(
    adapter.invoke("this_command_does_not_exist"),
  );
  assert.equal(error.code, "unavailable");
  assert.equal(error.capability, "this_command_does_not_exist");
  assert.equal(
    proposedMessageKeyForRejection("default", "this_command_does_not_exist"),
    PROPOSED_MESSAGE_KEYS.generic,
  );
  assert.equal(
    proposedMessageKeyForRejection("default", "browser_create"),
    PROPOSED_MESSAGE_KEYS.browserPanel,
  );
  assert.equal(
    proposedMessageKeyForRejection("default", "screenshot"),
    PROPOSED_MESSAGE_KEYS.screenshot,
  );
  // Prefixed vendor names are not invoke-router entries: they fall
  // through the same default path (design 6.5).
  const prefixed = await captureRejection(
    adapter.invoke("plugin:clipboard|read_text"),
  );
  assert.equal(prefixed.code, "unavailable");
  assert.equal(
    proposedMessageKeyForRejection("default", "plugin:clipboard|read_text"),
    PROPOSED_MESSAGE_KEYS.generic,
  );
});

test("names covered by the AD-14 ban reject through the default path", async () => {
  // The names are built at runtime so this source file never carries
  // the banned literals. All four share the default path: no entry,
  // no handler, no HTTP, generic message.
  const adapter = new WebInvokeAdapter();
  for (const suffix of ["open", "write", "resize", "close"]) {
    const command = ["plugin", `terminal_${suffix}`].join("_");
    const error = await captureRejection(adapter.invoke(command));
    assert.equal(error.code, "unavailable");
    assert.equal(
      proposedMessageKeyForRejection("default", command),
      PROPOSED_MESSAGE_KEYS.generic,
    );
  }
});

test("empty command names are invalid arguments", async () => {
  const adapter = new WebInvokeAdapter();
  const error = await captureRejection(adapter.invoke(""));
  assert.equal(error.code, "invalid_argument");
});

test("gated commands reject as unsupported", async () => {
  const adapter = new WebInvokeAdapter();
  assert.equal(isGatedCommand("self_hosted_sha256"), true);
  assert.equal(isGatedCommand("run_skill_script"), true);
  assert.equal(isGatedCommand("print_webview"), true);
  for (const command of [
    "self_hosted_sha256",
    "self_hosted_secure_get",
    "run_skill_script",
    "plugin_development_revision",
    "print_webview",
  ]) {
    const error = await captureRejection(adapter.invoke(command));
    assert.equal(error.code, "unsupported");
    assert.equal(error.capability, command);
  }
  assert.equal(
    proposedMessageKeyForRejection("gated", "self_hosted_sha256"),
    PROPOSED_MESSAGE_KEYS.gatedSelfHosted,
  );
  assert.equal(
    proposedMessageKeyForRejection("gated", "run_skill_script"),
    PROPOSED_MESSAGE_KEYS.gatedSkillRuntime,
  );
});

test("backend routes without a handler reject with an explicit 501", async () => {
  const adapter = new WebInvokeAdapter();
  for (const command of [
    "execute_record_transaction",
    "move_paths_to_trash",
    "create_managed_backup",
    "fuzzy_search",
    "plugin_read_host_state",
  ]) {
    const error = await captureRejection(adapter.invoke(command, {}));
    const route = getBackendRoute(command);
    assert.equal(error.code, "not_implemented");
    assert.equal(error.capability, command);
    assert.match(error.reason ?? "", /HTTP 501/);
    assert.match(error.reason ?? "", new RegExp(route?.path ?? "no-route"));
  }
  assert.equal(
    proposedMessageKeyForRejection("backend-not-implemented"),
    PROPOSED_MESSAGE_KEYS.backendNotYet,
  );
});

test("route table holds 56 dedicated endpoints and no generic path", () => {
  assert.equal(BACKEND_ROUTES.length, 56);
  const commands = BACKEND_ROUTES.map((route) => route.command);
  assert.equal(new Set(commands).size, 56);
  for (const route of BACKEND_ROUTES) {
    assert.ok(route.path.startsWith("/api/"), route.path);
    assert.ok(!route.path.startsWith("/api/invoke"), route.path);
  }
  const streamRoutes = BACKEND_ROUTES.filter((route) => route.stream === true);
  assert.equal(streamRoutes.length, 1);
  assert.equal(streamRoutes[0]?.command, AI_CHAT_STREAM_COMMAND);
  assert.equal(
    getBackendRoute("fuzzy_search")?.path,
    getBackendRoute("fuzzy_search_parallel")?.path,
  );
  assert.equal(
    getBackendRoute("restore_managed_backup")?.path,
    getBackendRoute("import_app_data")?.path,
  );
  assert.equal(
    getBackendRoute("import_skill")?.path,
    getBackendRoute("import_skill_zip")?.path,
  );
});

test("registered handlers receive the resolved transport request", async () => {
  const registry = createHandlerRegistry();
  const seen: unknown[] = [];
  registry.register("cancel_ai_request", async (context) => {
    seen.push(context.request);
    return true;
  });
  registry.register("list_managed_backups", async (context) => {
    seen.push(context.request);
    return [];
  });
  const adapter = createWebInvokeAdapter(registry);
  assert.equal(
    await adapter.invoke("cancel_ai_request", {
      requestId: "req-1",
      reason: "user",
    }),
    true,
  );
  assert.deepEqual(await adapter.invoke("list_managed_backups", { limit: 5 }), []);
  assert.equal(seen.length, 2);
  const cancelRequest = seen[0] as {
    path: string;
    body: Record<string, unknown>;
  };
  assert.equal(cancelRequest.path, "/api/ai/requests/req-1/cancel");
  assert.deepEqual(cancelRequest.body, { reason: "user" });
  const listRequest = seen[1] as {
    path: string;
    query: Record<string, string>;
  };
  assert.equal(listRequest.path, "/api/backups");
  assert.deepEqual(listRequest.query, { limit: "5" });
});

test("argument validation strips undefined and rejects non-JSON data", async () => {
  const registry = createHandlerRegistry();
  let seenArgs: unknown;
  registry.register("fuzzy_search", async (context) => {
    seenArgs = context.args;
    return [];
  });
  const adapter = createWebInvokeAdapter(registry);
  await adapter.invoke("fuzzy_search", { query: "note", missing: undefined });
  assert.deepEqual(seenArgs, { query: "note" });

  const plain = new WebInvokeAdapter();
  // Bad arguments are exercised on a phase 1 route: phase 1 routes
  // validate before the 501 check, while unbuilt phases reject with
  // 501 before validation (see the dispatch-order test below).
  for (const bad of [
    { fn: () => 1 },
    { when: new Date() },
    { count: Number.NaN },
    { count: Number.POSITIVE_INFINITY },
    { apiKey: "secret-value" },
    { nested: { list: [1, undefined] } },
  ]) {
    const error = await captureRejection(
      plain.invoke("execute_record_transaction", bad as Record<string, unknown>),
    );
    assert.equal(error.code, "invalid_argument");
  }
});

test("missing path placeholders reject locally", async () => {
  const registry = createHandlerRegistry();
  let calls = 0;
  registry.register("cancel_ai_request", async () => {
    calls += 1;
    return true;
  });
  const adapter = createWebInvokeAdapter(registry);
  const error = await captureRejection(adapter.invoke("cancel_ai_request", {}));
  assert.equal(error.code, "invalid_argument");
  assert.match(error.reason ?? "", /requestId/);
  assert.equal(calls, 0);
});

test("unbuilt phases reject with 501 before argument validation", async () => {
  // Design 2.2 step 4: a BACKEND route outside phase 1 with no
  // handler rejects as not built, even when the arguments are also
  // invalid. A phase 1 route validates first, so the same bad
  // arguments surface as a validation error instead.
  const adapter = new WebInvokeAdapter();
  const unbuilt = await captureRejection(
    adapter.invoke("fuzzy_search", { fn: () => 1 }),
  );
  assert.equal(unbuilt.code, "not_implemented");
  assert.match(unbuilt.reason ?? "", /HTTP 501/);
  const phase1 = await captureRejection(
    adapter.invoke("execute_record_transaction", { fn: () => 1 }),
  );
  assert.equal(phase1.code, "invalid_argument");
  // Once a handler exists, the unbuilt-phase route validates too.
  const registry = createHandlerRegistry();
  registry.register("fuzzy_search", async () => []);
  const withHandler = createWebInvokeAdapter(registry);
  const validated = await captureRejection(
    withHandler.invoke("fuzzy_search", { fn: () => 1 }),
  );
  assert.equal(validated.code, "invalid_argument");
});

test("handler failures never leak raw error text", async () => {
  const registry = createHandlerRegistry();
  registry.register("fuzzy_search", async () => {
    throw new Error("boom-detail-that-must-not-leak");
  });
  const adapter = createWebInvokeAdapter(registry);
  const error = await captureRejection(adapter.invoke("fuzzy_search", {}));
  assert.equal(error.code, "backend_error");
  assert.doesNotMatch(error.message, /boom-detail/);
});

test("handler registry rejects bad registrations", () => {
  const registry = createHandlerRegistry();
  assert.throws(() =>
    registry.register("not_a_backend_command", async () => null),
  );
  assert.throws(() =>
    registry.register(AI_CHAT_STREAM_COMMAND, async () => null),
  );
  registry.register("fuzzy_search", async () => []);
  assert.throws(() => registry.register("fuzzy_search", async () => []));
  assert.equal(registry.has("fuzzy_search"), true);
  assert.equal(registry.unregister("fuzzy_search"), true);
  assert.equal(registry.has("fuzzy_search"), false);
});

test("stream requests reject explicitly and never return an empty iterable", async () => {
  const adapter = new WebInvokeAdapter();
  const streamError = await captureRejection(
    adapter.stream(AI_CHAT_STREAM_COMMAND, {}),
  );
  assert.equal(streamError.code, "not_implemented");
  assert.match(streamError.reason ?? "", /\/api\/ai\/chat\/stream/);
  const otherError = await captureRejection(adapter.stream("fuzzy_search", {}));
  assert.equal(otherError.code, "unavailable");
  const invokeError = await captureRejection(
    adapter.invoke(AI_CHAT_STREAM_COMMAND, {
      onEvent: () => undefined,
    }),
  );
  assert.equal(invokeError.code, "not_implemented");
  assert.equal(
    proposedMessageKeyForRejection("stream-not-available"),
    PROPOSED_MESSAGE_KEYS.aiStreamNotYet,
  );
});
