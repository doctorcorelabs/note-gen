// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-os-platform-collision. Synthetic example.

import { arch, locale, platform, version } from '@tauri-apps/plugin-os';

export async function runtimeInfo(): Promise<string> {
  const os = platform();
  const versionName = version();
  const archName = arch();
  const localeName = await locale();
  return `${os}/${versionName}/${archName}/${localeName ?? 'unknown'}`;
}
