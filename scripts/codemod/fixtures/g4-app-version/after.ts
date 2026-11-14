// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-app-version. Synthetic example.

import { platform } from '@/lib/platform';

export async function appVersion(): Promise<string> {
  return platform.os.getAppVersion();
}

export async function appVersionLater(): Promise<string> {
  return platform.os.getAppVersion();
}
