// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the web notification adapter (V2-13, generation 3).
 *
 * No test runner is configured in package.json. Run with esbuild plus the
 * Node test runner (Node 24):
 *
 *   node_modules/.bin/esbuild src/lib/platform/notification/notification.fallback.test.ts \
 *     --bundle --platform=node --format=cjs --outfile=/tmp/v2-13-notification-fallback.test.cjs \
 *     && node --test /tmp/v2-13-notification-fallback.test.cjs
 *
 * The tests inject fake Notification API state so they run without a
 * browser. They cover in-app routing when the API is unavailable or
 * permission is not granted, the system channel when permission is
 * granted, the fallback when showing a system notification throws, empty
 * title rejection, listener error isolation, the 50-item cap, and
 * unsubscribe.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createWebNotificationAdapter } from "./notification.web";
import type { NotificationPermissionState } from "./interface";

describe("web notification fallback", () => {
  test("an unavailable API routes in-app and reports denied without prompting", async () => {
    const adapter = createWebNotificationAdapter({ isSupported: false });
    assert.equal(adapter.isSupported(), false);
    assert.equal(await adapter.isPermissionGranted(), false);
    assert.equal(await adapter.getPermission(), "denied");
    assert.equal(await adapter.requestPermission(), "denied");
    const delivery = await adapter.sendNotification({ title: "Hello", body: "World" });
    assert.equal(delivery.channel, "in-app");
    assert.equal(delivery.permission, "denied");
    assert.match(delivery.reason ?? "", /unavailable/);
    const held = adapter.getInAppNotifications();
    assert.equal(held.length, 1);
    assert.equal(held[0]?.title, "Hello");
    assert.equal(held[0]?.body, "World");
  });

  test("default permission routes in-app and never prompts from send", async () => {
    let created = 0;
    let prompted = 0;
    const adapter = createWebNotificationAdapter({
      isSupported: true,
      getPermission: (): NotificationPermissionState => "default",
      requestPermission: async () => {
        prompted += 1;
        return "granted";
      },
      createNotification: () => {
        created += 1;
      },
    });
    const delivery = await adapter.sendNotification("Waiting for permission");
    assert.equal(delivery.channel, "in-app");
    assert.equal(delivery.permission, "default");
    assert.match(delivery.reason ?? "", /requestPermission/);
    assert.equal(created, 0);
    assert.equal(prompted, 0);
    assert.equal(await adapter.isPermissionGranted(), false);
  });

  test("denied permission routes in-app with a denied reason", async () => {
    const adapter = createWebNotificationAdapter({
      isSupported: true,
      getPermission: (): NotificationPermissionState => "denied",
    });
    const delivery = await adapter.sendNotification({ title: "Blocked" });
    assert.equal(delivery.channel, "in-app");
    assert.equal(delivery.permission, "denied");
    assert.match(delivery.reason ?? "", /denied/);
  });

  test("granted permission uses the system channel with the full options", async () => {
    const shown: { title: string; options: Record<string, unknown> }[] = [];
    const adapter = createWebNotificationAdapter({
      isSupported: true,
      getPermission: (): NotificationPermissionState => "granted",
      createNotification: (title, options) => {
        shown.push({ title, options: { ...options } });
      },
    });
    assert.equal(await adapter.isPermissionGranted(), true);
    const delivery = await adapter.sendNotification({
      title: "Approval needed",
      body: "An agent run is waiting",
      icon: "/icon.png",
      tag: "agent",
      silent: true,
    });
    assert.equal(delivery.channel, "system");
    assert.equal(delivery.permission, "granted");
    assert.equal(delivery.reason, undefined);
    assert.equal(shown.length, 1);
    assert.equal(shown[0]?.title, "Approval needed");
    assert.equal(shown[0]?.options["body"], "An agent run is waiting");
    assert.equal(shown[0]?.options["icon"], "/icon.png");
    assert.equal(shown[0]?.options["tag"], "agent");
    assert.equal(shown[0]?.options["silent"], true);
    assert.equal(adapter.getInAppNotifications().length, 0);
  });

  test("a throwing system notification falls back in-app and still resolves", async () => {
    const adapter = createWebNotificationAdapter({
      isSupported: true,
      getPermission: (): NotificationPermissionState => "granted",
      createNotification: () => {
        throw new Error("Notification constructor boom");
      },
    });
    const delivery = await adapter.sendNotification({ title: "Kept in-app" });
    assert.equal(delivery.channel, "in-app");
    assert.equal(delivery.permission, "granted");
    assert.match(delivery.reason ?? "", /could not be shown/);
    assert.equal(adapter.getInAppNotifications().length, 1);
  });

  test("an empty title throws for both the string and object forms", async () => {
    const adapter = createWebNotificationAdapter({ isSupported: false });
    await assert.rejects(() => adapter.sendNotification(""), /must not be empty/);
    await assert.rejects(() => adapter.sendNotification("   "), /must not be empty/);
    await assert.rejects(() => adapter.sendNotification({ title: "" }), /must not be empty/);
    assert.equal(adapter.getInAppNotifications().length, 0);
  });

  test("a throwing fallback listener does not reject the send or skip other listeners", async () => {
    const errors: unknown[] = [];
    const adapter = createWebNotificationAdapter({
      isSupported: false,
      onHandlerError: (error) => {
        errors.push(error);
      },
    });
    let goodCalls = 0;
    adapter.onInAppNotification(() => {
      throw new Error("toast boom");
    });
    adapter.onInAppNotification(() => {
      goodCalls += 1;
    });
    const delivery = await adapter.sendNotification({ title: "Recorded anyway" });
    assert.equal(delivery.channel, "in-app");
    assert.equal(goodCalls, 1);
    assert.equal(errors.length, 1);
    assert.equal(adapter.getInAppNotifications().length, 1);
  });

  test("the in-app list caps at 50 oldest-first and clear empties it", async () => {
    const adapter = createWebNotificationAdapter({ isSupported: false });
    for (let i = 0; i < 55; i += 1) {
      await adapter.sendNotification({ title: `note-${i}` });
    }
    const held = adapter.getInAppNotifications();
    assert.equal(held.length, 50);
    assert.equal(held[0]?.title, "note-5");
    assert.equal(held[49]?.title, "note-54");
    adapter.clearInAppNotifications();
    assert.equal(adapter.getInAppNotifications().length, 0);
  });

  test("unsubscribing stops fallback delivery", async () => {
    const adapter = createWebNotificationAdapter({ isSupported: false });
    let calls = 0;
    const unlisten = adapter.onInAppNotification(() => {
      calls += 1;
    });
    await adapter.sendNotification({ title: "first" });
    unlisten();
    await adapter.sendNotification({ title: "second" });
    assert.equal(calls, 1);
    assert.equal(adapter.getInAppNotifications().length, 2);
  });

  test("requestPermission delegates to the injected prompter when the API exists", async () => {
    const adapter = createWebNotificationAdapter({
      isSupported: true,
      getPermission: (): NotificationPermissionState => "default",
      requestPermission: async () => "granted",
    });
    assert.equal(await adapter.requestPermission(), "granted");
  });
});
