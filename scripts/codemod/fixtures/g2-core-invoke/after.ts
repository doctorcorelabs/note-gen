// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g2-core-invoke. Synthetic example.

import { platform } from '@/lib/platform';

export async function callBackend(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const callbackId = platform.invoke.transformCallback((response: unknown) => response);
  return platform.invoke.invoke(cmd, { ...args, callbackId });
}
