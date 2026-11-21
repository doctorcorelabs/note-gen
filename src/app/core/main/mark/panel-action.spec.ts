// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Behavior specs for runPanelAction (T-02-02).
//
// Run: `pnpm vitest run --project unit src/app/core/main/mark/panel-action.spec.ts`

import { describe, expect, it, vi } from "vitest";

import { runPanelAction } from "./panel-action";

function conflictError() {
  return Object.assign(new Error("conflict"), { code: "revision_conflict" });
}

describe("runPanelAction (T-02-02)", () => {
  it("runs the action without reporting on success", async () => {
    const showError = vi.fn();
    await runPanelAction(async () => {}, {
      isConflict: () => false,
      showError,
    });
    expect(showError).not.toHaveBeenCalled();
  });

  it("stays silent for revision conflicts (store already toasted)", async () => {
    const showError = vi.fn();
    await runPanelAction(
      async () => {
        throw conflictError();
      },
      {
        isConflict: error =>
          error instanceof Error && "code" in error && error.code === "revision_conflict",
        showError,
      },
    );
    expect(showError).not.toHaveBeenCalled();
  });

  it("reports non-conflict errors exactly once", async () => {
    const showError = vi.fn();
    const failure = new Error("network down");
    await runPanelAction(
      async () => {
        throw failure;
      },
      { isConflict: () => false, showError },
    );
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(failure);
  });

  it("runs the finally callback on failure (dialog close)", async () => {
    const onFinally = vi.fn();
    await runPanelAction(
      async () => {
        throw new Error("delete failed");
      },
      { isConflict: () => false, showError: () => {} },
      onFinally,
    );
    expect(onFinally).toHaveBeenCalledTimes(1);
  });

  it("runs the finally callback on success", async () => {
    const onFinally = vi.fn();
    await runPanelAction(
      async () => {},
      { isConflict: () => false, showError: () => {} },
      onFinally,
    );
    expect(onFinally).toHaveBeenCalledTimes(1);
  });

  it("maps a clipboard-style rejection to the error reporter", async () => {
    const showError = vi.fn();
    await runPanelAction(
      async () => {
        await Promise.reject(new Error("clipboard denied"));
      },
      { isConflict: () => false, showError },
    );
    expect(showError).toHaveBeenCalledTimes(1);
  });
});
