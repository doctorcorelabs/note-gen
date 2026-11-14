// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-os-platform-collision. Synthetic example.

import { platform } from '@/lib/platform';

export async function runtimeInfo(): Promise<string> {
  const os = platform.os.platform();
  const versionName = platform.os.version();
  const archName = platform.os.arch();
  const localeName = await platform.os.locale();
  return `${os}/${versionName}/${archName}/${localeName ?? 'unknown'}`;
}
