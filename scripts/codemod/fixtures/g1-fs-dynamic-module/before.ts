// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g1-fs-dynamic-module. Synthetic example.

export async function readViaModule(path: string): Promise<string> {
  return import('@tauri-apps/plugin-fs').then((module) => module.readTextFile(path));
}

export async function readViaAwait(path: string): Promise<string> {
  const module = await import('@tauri-apps/plugin-fs');
  return module.readTextFile(path);
}
