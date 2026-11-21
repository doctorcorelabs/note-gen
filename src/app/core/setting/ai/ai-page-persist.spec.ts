// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-03, SET-04, SET-06) static pins for the AI settings
// page. The page graph is too heavy to mount in a unit test, so
// following the setting-funnel.spec.ts precedent these pins
// guard the presence and shape of the fixes in source:
// - SET-03: init and every provider mutation surface failures
//   with a toast instead of an unhandled rejection.
// - SET-04: copy/delete/create write through state + funnel
//   flush, never a stale store snapshot.
// - SET-06: both delete paths clear stale model roles.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, "page.tsx"), "utf8");
const CREATE = readFileSync(join(HERE, "create.tsx"), "utf8");

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("DA-3 SET-03 AI page failure honesty", () => {
  it("init surfaces load failures instead of rejecting unhandled", () => {
    expect(PAGE).toContain("init().catch(");
    expect(PAGE).toContain("t('loadFailed')");
  });

  it("addProviderFromTemplate catches and toasts", () => {
    const fn = sliceBetween(PAGE, "const addProviderFromTemplate", "\n  const copyConfig");
    expect(fn).toContain("catch (error)");
    expect(fn).toContain("toast(");
  });

  it("copyConfig catches and toasts", () => {
    const fn = sliceBetween(PAGE, "const copyConfig", "\n  const deleteCurrentConfig");
    expect(fn).toContain("catch (error)");
    expect(fn).toContain("toast(");
  });

  it("deleteCurrentConfig catches and toasts", () => {
    const fn = sliceBetween(PAGE, "const deleteCurrentConfig", "\n  const migrateOldConfig");
    expect(fn).toContain("catch (error)");
    expect(fn).toContain("toast(");
  });

  it("addCustomProvider catches and toasts", () => {
    const fn = sliceBetween(CREATE, "const addCustomProvider", "\n  return (");
    expect(fn).toContain("catch (error)");
    expect(fn).toContain("toast(");
  });
});

describe("DA-3 SET-04 single aiModelList write path", () => {
  it("copyConfig reads the ref and persists through the funnel", () => {
    const fn = sliceBetween(PAGE, "const copyConfig", "\n  const deleteCurrentConfig");
    expect(fn).toContain("aiModelListRef.current");
    expect(fn).toContain("persistAiModelList(");
    expect(fn).not.toContain("store.get<AiConfig[]>('aiModelList')");
    expect(fn).not.toContain("store.set('aiModelList'");
  });

  it("deleteCurrentConfig reads the ref and persists through the funnel", () => {
    const fn = sliceBetween(PAGE, "const deleteCurrentConfig", "\n  const migrateOldConfig");
    expect(fn).toContain("aiModelListRef.current");
    expect(fn).toContain("persistAiModelList(");
    expect(fn).not.toContain("store.get<AiConfig[]>('aiModelList')");
    expect(fn).not.toContain("store.set('aiModelList'");
  });

  it("addProviderFromTemplate persists through the funnel", () => {
    const fn = sliceBetween(PAGE, "const addProviderFromTemplate", "\n  const copyConfig");
    expect(fn).toContain("persistAiModelList(");
    expect(fn).not.toContain("store.set('aiModelList'");
  });

  it("addCustomProvider reads state and flushes the funnel", () => {
    const fn = sliceBetween(CREATE, "const addCustomProvider", "\n  return (");
    expect(fn).toContain("useSettingStore.getState().aiModelList");
    expect(fn).toContain("flushChangedSyncableSettingsPersist");
    expect(fn).not.toContain("store.get");
    expect(fn).not.toContain("store.set");
  });
});

describe("DA-3 SET-06 stale role clearing on delete", () => {
  it("deleteModel clears roles referencing the model", () => {
    const fn = sliceBetween(PAGE, "const deleteModel", "\n  const updateModelConfig");
    expect(fn).toContain("clearModelRoles");
    expect(fn).toContain("roleValueReferencesModel");
  });

  it("deleteCurrentConfig clears roles referencing the provider", () => {
    const fn = sliceBetween(PAGE, "const deleteCurrentConfig", "\n  const migrateOldConfig");
    expect(fn).toContain("clearModelRoles");
    expect(fn).toContain("roleValueReferencesConfig");
  });
});
