// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the in-app notification toast bridge (ACT-02),
 * node:test convention. Run through an esbuild bundle:
 *
 *   ./node_modules/.bin/esbuild src/lib/platform/notification/in-app-toasts.spec.ts \
 *     --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert \
 *     --outfile=<staging-dir>/in-app-toasts.spec.mjs
 *   node --test <staging-dir>/in-app-toasts.spec.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { subscribeInAppNotificationToasts } from "./in-app-toasts";
import type {
  InAppNotification,
  InAppNotificationListener,
  NotificationAdapter,
  NotificationAdapterExtensions,
} from "./interface";

function fakeAdapter() {
  const listeners = new Set<InAppNotificationListener>();
  const adapter = {
    onInAppNotification(listener: InAppNotificationListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as NotificationAdapter & Partial<NotificationAdapterExtensions>;
  const emit = (notification: InAppNotification) => {
    for (const listener of listeners) listener(notification);
  };
  return { adapter, emit, listenerCount: () => listeners.size };
}

describe("subscribeInAppNotificationToasts", () => {
  it("forwards in-app notifications to the toast surface", () => {
    const { adapter, emit } = fakeAdapter();
    const shown: Array<{ title: string; description?: string }> = [];
    const unsubscribe = subscribeInAppNotificationToasts(adapter, toast => {
      shown.push(toast);
    });
    assert.ok(unsubscribe);
    emit({ id: "1", title: "Approval needed", body: "Check the request", receivedAt: 1 });
    assert.deepEqual(shown, [{ title: "Approval needed", description: "Check the request" }]);
  });

  it("stops forwarding after unsubscribe", () => {
    const { adapter, emit, listenerCount } = fakeAdapter();
    const shown: unknown[] = [];
    const unsubscribe = subscribeInAppNotificationToasts(adapter, toast => {
      shown.push(toast);
    });
    assert.ok(unsubscribe);
    unsubscribe();
    assert.equal(listenerCount(), 0);
    emit({ id: "2", title: "Late", receivedAt: 2 });
    assert.equal(shown.length, 0);
  });

  it("returns null when the adapter has no fallback surface", () => {
    const adapter = {} as NotificationAdapter & Partial<NotificationAdapterExtensions>;
    assert.equal(subscribeInAppNotificationToasts(adapter, () => {}), null);
  });
});
