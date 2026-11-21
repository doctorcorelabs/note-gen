// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-17): pure conversion between stored customHeaders
// JSON and the editable key/value rows on the AI settings page.
// Row ids are deterministic per position so re-parsing the same
// headers never remounts inputs (the old Math.random ids changed
// on every parse and dropped input focus).

export interface HeaderPair {
  key: string
  value: string
  id: string
}

export function parseHeadersToKeyValue(
  headers: Record<string, string> = {},
): HeaderPair[] {
  return Object.entries(headers).map(([key, value], index) => ({
    key,
    value: String(value),
    id: `header-${index}`,
  }))
}

export function convertKeyValueToJson(
  pairs: Array<{ key: string, value: string }>,
): Record<string, string> {
  const obj: Record<string, string> = {}
  pairs.forEach(pair => { if (pair.key.trim()) obj[pair.key.trim()] = pair.value })
  return obj
}
