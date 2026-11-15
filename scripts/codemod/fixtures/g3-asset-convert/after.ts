// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-asset-convert. Synthetic example.

import { platform } from '@/lib/platform';

export function assetUrl(filePath: string): string {
  return platform.assetUrl.convertFileSrc(filePath);
}
