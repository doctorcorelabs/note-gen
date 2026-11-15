// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g2-http-static. Synthetic example.

import { platform } from '@/lib/platform';
import type { ClientOptions, Proxy } from '@/lib/platform';

export async function fetchWithOptions(url: string, options: ClientOptions, proxy: Proxy): Promise<string> {
  const response = await platform.http.fetch(url, { ...options, proxy });
  return response.text();
}
