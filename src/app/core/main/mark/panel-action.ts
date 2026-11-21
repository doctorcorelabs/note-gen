// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-2 (T-02-02): shared guard for mark-detail panel handlers.
// The mark store rethrows non-conflict write errors by contract
// ("callers with their own handling keep working"), so every
// panel handler must catch. Eight handlers did not, turning
// failures into unhandled rejections with no user signal.
// runPanelAction applies the panel's established pattern
// (handleRegenerateDesc): revision conflicts stay silent here
// because the store already showed the conflict toast; every
// other error is reported exactly once.

export interface PanelActionDeps {
  isConflict: (error: unknown) => boolean
  showError: (error: unknown) => void
}

export async function runPanelAction(
  action: () => Promise<void>,
  deps: PanelActionDeps,
  onFinally?: () => void,
): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (!deps.isConflict(error)) {
      deps.showError(error)
    }
  } finally {
    onFinally?.()
  }
}
