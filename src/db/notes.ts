import { platform, BaseDirectory } from "@/lib/platform"
import { getSqlAdapter } from "./index"

export interface Note {
  id: number
  tagId: number
  content?: string
  locale: string
  count: string
  createdAt: number
}

// Filesystem setup only: the `article` directory. The notes table
// itself is server-owned (migrations); no DDL runs here. The DDL
// half of this function died with the V3-14 funnel closure.
export async function initNotesDb() {
  const isExist = await platform.fs.exists('article', { baseDir: BaseDirectory.AppData})
  if (!isExist) {
    await platform.fs.mkdir('article', { baseDir: BaseDirectory.AppData})
  }
}

export async function insertNote(note: Partial<Note>) {
  // Migrated to kind `notes.insert` in wave 4 (W4-CODEMOD).
  // `createdAt` is server-assigned; a caller-supplied value is
  // ignored, matching the kind input shape.
  return await getSqlAdapter().execute({
    kind: 'notes.insert',
    note: {
      tagId: note.tagId as number,
      content: note.content,
      locale: note.locale as string,
      count: note.count as string,
    },
  })
}

export async function getNoteByTagId(tagId: number) {
  // Migrated to kind `notes.latestByTag` in wave 4 (W4-CODEMOD).
  const row = await getSqlAdapter().queryOne({ kind: 'notes.latestByTag', tagId })
  return row ?? undefined
}

// Class C (desain-rekonsiliasi-tiga-bentuk-sql section 4):
// `getNoteById`, `getNotesByTagId`, and `delNote` have no catalog
// kind, were verified to have zero callers, and were deleted in
// wave 4 (W4-CODEMOD) instead of migrated. Do not revive them
// without a kind.
