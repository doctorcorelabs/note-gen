// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Specs for the trash panel pure helpers (F-05-01).
//
// Run: `pnpm vitest run --project unit src/app/core/main/file/trash-panel-model.spec.ts`
// from the repo root.

import { describe, expect, it } from 'vitest'
import type { WorkspaceTrashEntry } from '@/lib/platform/invoke/workspace-trash-handler'
import { appendTrashPage, formatTrashSize, removeTrashEntries } from './trash-panel-model'

function entry(id: string): WorkspaceTrashEntry {
  return {
    id,
    originalPath: `Folder/${id}.md`,
    name: `${id}.md`,
    kind: 'file',
    size: 10,
    entryCount: 1,
    revision: null,
    deletedAt: '2026-11-22T00:00:00.000Z',
  }
}

describe('appendTrashPage', () => {
  it('appends a page in server order', () => {
    const merged = appendTrashPage([entry('a')], [entry('b'), entry('c')])
    expect(merged.map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('skips ids already present so pages never duplicate rows', () => {
    const merged = appendTrashPage([entry('a'), entry('b')], [entry('b'), entry('c')])
    expect(merged.map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the existing list', () => {
    const existing = [entry('a')]
    appendTrashPage(existing, [entry('b')])
    expect(existing.map(item => item.id)).toEqual(['a'])
  })
})

describe('removeTrashEntries', () => {
  it('drops only the given ids', () => {
    const remaining = removeTrashEntries([entry('a'), entry('b'), entry('c')], new Set(['b']))
    expect(remaining.map(item => item.id)).toEqual(['a', 'c'])
  })

  it('keeps everything when no id matches', () => {
    const remaining = removeTrashEntries([entry('a')], new Set(['zzz']))
    expect(remaining.map(item => item.id)).toEqual(['a'])
  })
})

describe('formatTrashSize', () => {
  it('formats bytes and each unit boundary', () => {
    expect(formatTrashSize(0)).toBe('0 B')
    expect(formatTrashSize(512)).toBe('512 B')
    expect(formatTrashSize(1024)).toBe('1 KB')
    expect(formatTrashSize(1536)).toBe('1.5 KB')
    expect(formatTrashSize(1024 * 1024)).toBe('1 MB')
    expect(formatTrashSize(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatTrashSize(2 * 1024 * 1024 * 1024)).toBe('2 GB')
  })

  it('treats invalid sizes as 0 B', () => {
    expect(formatTrashSize(-1)).toBe('0 B')
    expect(formatTrashSize(Number.NaN)).toBe('0 B')
  })
})
