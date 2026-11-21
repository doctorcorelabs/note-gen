// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-12): remove the empty output file left behind when
// Organize fails before any content was generated. Partial
// content belongs to the user and is never deleted. Cleanup
// failures are logged and swallowed: cleanup must never mask
// the original Organize error or throw out of the catch block.

export interface OrganizeCleanupDeps {
  readTextFile: () => Promise<string>
  removeFile: () => Promise<void>
}

export async function cleanupEmptyOrganizeOutput(
  deps: OrganizeCleanupDeps,
): Promise<boolean> {
  try {
    const content = await deps.readTextFile()
    if (content.trim() !== "") return false
    await deps.removeFile()
    return true
  } catch (error) {
    console.error("Failed to clean up empty Organize output:", error)
    return false
  }
}
