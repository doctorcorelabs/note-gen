// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g2-http-dynamic. Synthetic example.

export async function fetchLater(url: string): Promise<string> {
  const { fetch } = await import('@tauri-apps/plugin-http');
  const response = await fetch(url);
  return response.text();
}
