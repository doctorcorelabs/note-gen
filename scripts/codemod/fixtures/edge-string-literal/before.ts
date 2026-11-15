// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: edge-string-literal. Synthetic example.

export function diagnosticMessage(): string {
  return 'Missing optional module: @tauri-apps/plugin-store (web fallback in use).';
}

// The string above names @tauri-apps/plugin-store only as diagnostic text.
export function hasFallback(): boolean {
  return true;
}
