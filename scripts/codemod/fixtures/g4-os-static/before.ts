// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-os-static. Synthetic example.

import { arch, locale as getSystemLocale, platform as getRuntimePlatform, version as osVersion } from '@tauri-apps/plugin-os';

export async function runtimeInfo(): Promise<string> {
  const os = getRuntimePlatform();
  const version = osVersion();
  const archName = arch();
  const locale = await getSystemLocale();
  return `${os}/${version}/${archName}/${locale ?? 'unknown'}`;
}
