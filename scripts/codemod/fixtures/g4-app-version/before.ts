// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-app-version. Synthetic example.

import { getVersion } from '@tauri-apps/api/app';

export async function appVersion(): Promise<string> {
  return getVersion();
}

export async function appVersionLater(): Promise<string> {
  const { getVersion: getVersionDynamic } = await import('@tauri-apps/api/app');
  return getVersionDynamic();
}
