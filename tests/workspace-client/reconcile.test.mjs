// SPDX-License-Identifier: GPL-3.0-only
// Conformance: reconcile trigger and status. Contract:
// kontrak-api-kanonis.md section 3.1; V1-09 sections 4.5, 1.3.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIsoUtc,
  createFile,
  expectError,
  expectOk,
  request,
  setupContext,
  skipUnlessMock,
  sleep,
} from "./helpers.mjs";

const ctx = await setupContext();

async function waitForIdle() {
  for (let i = 0; i < 40; i += 1) {
    const resp = await request(ctx, "GET", "/api/workspace/reconcile");
    const data = expectOk(resp, 200, "reconcile status poll");
    if (!data.running) return data;
    await sleep(50);
  }
  throw new Error("reconcile did not become idle");
}

test("GET reconcile returns the status shape", async () => {
  const resp = await request(ctx, "GET", "/api/workspace/reconcile");
  const data = expectOk(resp, 200, "reconcile status");
  assert.equal(typeof data.running, "boolean");
  assert.ok(data.lastRun === null || typeof data.lastRun === "object");
  assert.equal(typeof data.driftWarning, "boolean");
  assert.equal(typeof data.driftCritical, "boolean");
  assert.equal(typeof data.watcherDegraded, "boolean");
  assertIsoUtc(data.nextScheduledRunAt);
});

test("POST reconcile returns 202 and completes with a lastRun report", async () => {
  await createFile(ctx, ctx.path("reconcile", "a.md"), "a");
  const resp = await request(ctx, "POST", "/api/workspace/reconcile", {
    json: { full: true, dryRun: false },
  });
  const data = expectOk(resp, 202, "reconcile trigger");
  assert.equal(typeof data.jobId, "string");
  assert.equal(data.status, "running");
  assert.equal(data.full, true);
  assert.equal(data.dryRun, false);
  assertIsoUtc(data.startedAt);
  const status = await waitForIdle();
  assert.equal(status.lastRun.jobId, data.jobId);
  assert.equal(status.lastRun.status, "completed");
  assertIsoUtc(status.lastRun.startedAt);
  assertIsoUtc(status.lastRun.finishedAt);
  assert.ok(Number.isInteger(status.lastRun.filesScanned));
  assert.ok(Number.isInteger(status.lastRun.driftFound));
  assert.ok(Number.isInteger(status.lastRun.driftRepaired));
  assert.ok(Array.isArray(status.lastRun.driftPaths));
  assert.equal(typeof status.lastRun.categories, "object");
  assert.equal(status.lastRun.dryRun, false);
});

test("POST reconcile honors dryRun", async () => {
  const resp = await request(ctx, "POST", "/api/workspace/reconcile", {
    json: { dryRun: true },
  });
  const data = expectOk(resp, 202, "reconcile dry run");
  assert.equal(data.full, true);
  assert.equal(data.dryRun, true);
  const status = await waitForIdle();
  assert.equal(status.lastRun.jobId, data.jobId);
  assert.equal(status.lastRun.dryRun, true);
});

test("POST reconcile rejects unknown fields and wrong types", async () => {
  const unknown = await request(ctx, "POST", "/api/workspace/reconcile", {
    json: { full: true, workspaceId: "ws-1" },
  });
  expectError(unknown, 400, "validation_failed");
  const wrongType = await request(ctx, "POST", "/api/workspace/reconcile", {
    json: { full: "yes" },
  });
  expectError(wrongType, 400, "validation_failed");
});

test("concurrent reconcile trigger returns 409 while running", skipUnlessMock(ctx, "overlap timing is only deterministic against the mock hold window"), async () => {
  await waitForIdle();
  const [first, second] = await Promise.all([
    request(ctx, "POST", "/api/workspace/reconcile", { json: {} }),
    request(ctx, "POST", "/api/workspace/reconcile", { json: {} }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [202, 409]);
  const conflict = first.status === 409 ? first : second;
  expectError(conflict, 409, "reconcile_already_running");
  await waitForIdle();
});

test("GET reconcile does not start a run", skipUnlessMock(ctx, "scheduled runs on a real backend can change lastRun between reads"), async () => {
  await waitForIdle();
  const before = expectOk(await request(ctx, "GET", "/api/workspace/reconcile"), 200, "status before");
  const after = expectOk(await request(ctx, "GET", "/api/workspace/reconcile"), 200, "status after");
  assert.equal(after.running, false);
  assert.deepEqual(after.lastRun, before.lastRun);
});
