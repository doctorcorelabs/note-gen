// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g3-asset-convert. Synthetic example.

import { convertFileSrc } from '@tauri-apps/api/core';

export function assetUrl(filePath: string): string {
  return convertFileSrc(filePath);
}
