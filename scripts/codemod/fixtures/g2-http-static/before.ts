// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g2-http-static. Synthetic example.

import { fetch as httpFetch } from '@tauri-apps/plugin-http';
import type { ClientOptions, Proxy } from '@tauri-apps/plugin-http';

export async function fetchWithOptions(url: string, options: ClientOptions, proxy: Proxy): Promise<string> {
  const response = await httpFetch(url, { ...options, proxy });
  return response.text();
}
