// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g2-http-dynamic. Synthetic example.

import { platform } from '@/lib/platform';

export async function fetchLater(url: string): Promise<string> {
  const response = await platform.http.fetch(url);
  return response.text();
}
