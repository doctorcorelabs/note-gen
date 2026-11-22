// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Knowledge index persistence client, migrated to typed catalog
// kinds (BUG-02). The legacy `db` facade always rejects in web
// mode, so every read and write below goes through
// getSqlAdapter() with `knowledge.*` kinds from ops-catalog.ts.
// All six kinds have real server handlers, so reads and writes
// both work in Fase 1. Schema creation (the old initKnowledgeDb
// CREATE TABLE block, including the legacy article migration
// from vector_documents) is gone: it had no caller, and the
// server owns the knowledge_sources table.

import { getSqlAdapter } from './index'
import type {
  KnowledgeIndexStatus,
  KnowledgeSource,
  KnowledgeSourceType,
} from '@/types/knowledge'

export async function upsertKnowledgeSource(source: KnowledgeSource) {
  await getSqlAdapter().execute({ kind: 'knowledge.upsertSource', source })
}

export async function getKnowledgeSource(sourceKey: string): Promise<KnowledgeSource | null> {
  const row = await getSqlAdapter().queryOne({ kind: 'knowledge.getSource', sourceKey })
  return (row ?? null) as KnowledgeSource | null
}

const KNOWLEDGE_PAGE_LIMIT = 200

// The `knowledge.listSources` cursor is "<updatedAtMs>:<sourceKey>"
// (sourceKey percent-encoded) over updatedAt-descending order.
// Page until a short page so callers never silently truncate at
// the server default limit of 50 (IM-2 F08-01).
export async function getKnowledgeSources(options: {
  sourceTypes?: readonly KnowledgeSourceType[]
  statuses?: readonly KnowledgeIndexStatus[]
} = {}): Promise<KnowledgeSource[]> {
  const sources: KnowledgeSource[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await getSqlAdapter().query({
      kind: 'knowledge.listSources',
      ...(options.sourceTypes?.length ? { sourceTypes: [...options.sourceTypes] } : {}),
      ...(options.statuses?.length ? { statuses: [...options.statuses] } : {}),
      ...(cursor === undefined ? {} : { cursor }),
      limit: KNOWLEDGE_PAGE_LIMIT,
    }) as KnowledgeSource[]
    sources.push(...page)
    if (page.length < KNOWLEDGE_PAGE_LIMIT) return sources
    const last = page[page.length - 1]
    cursor = `${last.updatedAt}:${encodeURIComponent(last.sourceKey)}`
  }
}

export async function updateKnowledgeSourceIndexState(
  sourceKey: string,
  update: {
    status: KnowledgeIndexStatus
    indexedHash?: string | null
    error?: string | null
  }
) {
  await getSqlAdapter().execute({
    kind: 'knowledge.updateStatus',
    sourceKey,
    update: {
      status: update.status,
      indexedHash: update.indexedHash ?? null,
      error: update.error ?? null,
    },
  })
}

export async function deleteKnowledgeSource(sourceKey: string) {
  await getSqlAdapter().execute({ kind: 'knowledge.removeSource', sourceKey })
}

export async function getKnowledgeIndexStats() {
  const rows = await getSqlAdapter().query({ kind: 'knowledge.stats' })
  const stats = rows[0] as
    | Record<KnowledgeSourceType, Record<KnowledgeIndexStatus, number>>
    | undefined
  return stats ?? {
    article: { pending: 0, indexing: 0, ready: 0, failed: 0 },
    record: { pending: 0, indexing: 0, ready: 0, failed: 0 },
    canvas: { pending: 0, indexing: 0, ready: 0, failed: 0 },
  }
}
