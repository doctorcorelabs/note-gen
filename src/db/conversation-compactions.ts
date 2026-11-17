import { getDb, getSqlAdapter } from './index'
import { enqueueAutoDataSync } from '@/lib/sync/auto-data-sync-queue'
import { nextConversationSyncTimestamp } from './conversation-sync-state'

export interface ConversationCompaction {
  id: number
  conversationId: number
  summary: string
  coveredThroughChatId: number
  tailStartChatId?: number
  sourceTokenCount: number
  summaryTokenCount: number
  model: string
  promptVersion: number
  retainedTurnCount: number
  prunedToolResultCount: number
  prunedToolTokenCount: number
  revision: number
  createdAt: number
}

export type NewConversationCompaction = Omit<ConversationCompaction, 'id' | 'createdAt' | 'revision'>

export async function getLatestConversationCompaction(
  conversationId: number
): Promise<ConversationCompaction | null> {
  // Migrated to kind `compactions.listByConversation` in wave 4
  // (W4-CODEMOD). The kind orders by revision descending; the
  // first row is the latest.
  const rows = await getSqlAdapter().query({
    kind: 'compactions.listByConversation',
    conversationId,
    limit: 1,
  })
  return rows[0] ?? null
}

export async function insertConversationCompaction(compaction: NewConversationCompaction) {
  // Migrated to kind `compactions.insert` in wave 4 (W4-CODEMOD).
  // The server assigns `revision` (latest plus one) and
  // `createdAt`, so the saved row is re-read to return the full
  // shape callers expect (notably `revision`). The upstream
  // `conversations.syncUpdatedAt` touch has no kind and is
  // dropped; the sync-queue notice is kept.
  await getSqlAdapter().execute({
    kind: 'compactions.insert',
    compaction: {
      conversationId: compaction.conversationId,
      summary: compaction.summary,
      coveredThroughChatId: compaction.coveredThroughChatId,
      tailStartChatId: compaction.tailStartChatId,
      sourceTokenCount: compaction.sourceTokenCount,
      summaryTokenCount: compaction.summaryTokenCount,
      model: compaction.model,
      promptVersion: compaction.promptVersion,
      retainedTurnCount: compaction.retainedTurnCount,
      prunedToolResultCount: compaction.prunedToolResultCount,
      prunedToolTokenCount: compaction.prunedToolTokenCount,
    },
  })
  const saved = await getLatestConversationCompaction(compaction.conversationId)
  if (saved === null) {
    throw new Error('compactions.insert succeeded but the saved row was not found')
  }

  enqueueAutoDataSync('conversations', 'conversation-compaction-created')

  return saved satisfies ConversationCompaction
}

export async function deleteConversationCompactions(conversationId: number) {
  // NOT migrated in wave 4: no catalog kind deletes compactions.
  // Its callers (stores/chat.ts) keep calling this dead path
  // until a kind lands; the sync touch below has no kind either.
  const db = await getDb()
  const syncUpdatedAt = await nextConversationSyncTimestamp()
  await db.execute(
    'delete from conversation_compactions where conversationId = $1',
    [conversationId]
  )
  await db.execute(
    'update conversations set syncUpdatedAt = $1 where id = $2',
    [syncUpdatedAt, conversationId]
  )
  enqueueAutoDataSync('conversations', 'conversation-compaction-deleted')
}

// `initConversationCompactionsDb` (pure DDL) and
// `deleteAllConversationCompactions` (no kind, zero callers)
// were deleted in wave 4 (W4-CODEMOD). The table is
// server-owned (migrations).
