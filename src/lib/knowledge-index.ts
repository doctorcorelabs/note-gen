import { platform } from '@/lib/platform'
import {
  deleteKnowledgeSource,
  getKnowledgeSource,
  getKnowledgeSources,
  updateKnowledgeSourceIndexState,
  upsertKnowledgeSource,
} from '@/db/knowledge'
import {
  deleteVectorDocumentsByFilename,
  getVectorDocumentsByFilename,
  replaceVectorDocumentsByFilename,
} from '@/db/vector'
import { fetchEmbeddings } from '@/lib/ai'
import { getBM25Index } from '@/lib/bm25'
import {
  collectCanvasKnowledgeDocuments,
  collectRecordKnowledgeDocuments,
  getKnowledgeSourceDocument,
} from '@/lib/knowledge-content'
import { getKnowledgeSettings, isKnowledgeSourceEnabled } from '@/lib/knowledge-settings'
import type { KnowledgeSourceDocument, KnowledgeSourceType } from '@/types/knowledge'

const pendingKeys = new Set<string>()
let drainPromise: Promise<void> | null = null

async function isAutoIndexEnabled() {
  const store = await platform.store.load('store.json')
  return (await getKnowledgeSettings()).semanticSearchEnabled
    && (await store.get<boolean>('autoVectorEnabled') ?? true)
}

async function hasStructuredIndexConsent() {
  const store = await platform.store.load('store.json')
  return await store.get<boolean>('ragStructuredKnowledgeConsent') ?? false
}

async function registerDocument(document: KnowledgeSourceDocument) {
  const existing = await getKnowledgeSource(document.sourceKey)
  const unchanged = existing?.contentHash === document.contentHash
    && existing.indexedHash === document.contentHash
    && existing.status === 'ready'
  await upsertKnowledgeSource({
    ...document,
    indexedHash: unchanged ? existing.indexedHash : null,
    status: unchanged ? 'ready' : 'pending',
    error: null,
  })
  getBM25Index()?.replaceByFilename(
    document.sourceKey,
    document.chunks.map(chunk => chunk.content)
  )
  return !unchanged
}

export async function indexKnowledgeDocument(document: KnowledgeSourceDocument): Promise<boolean> {
  try {
    // DA-2 (K-02): registration is inside the try so a register
    // failure also ends in the honest failed state below instead
    // of leaving the source pending forever.
    const needsIndex = await registerDocument(document)
    if (!needsIndex) return true
    await updateKnowledgeSourceIndexState(document.sourceKey, {
      status: 'indexing',
      indexedHash: null,
    })
    const embeddings: Array<number[] | null> = []
    for (let offset = 0; offset < document.chunks.length; offset += 16) {
      embeddings.push(...await fetchEmbeddings(
        document.chunks.slice(offset, offset + 16).map(chunk => chunk.content)
      ))
    }
    if (embeddings.length !== document.chunks.length || embeddings.some(item => !item)) {
      throw new Error('The embedding result is incomplete')
    }
    await replaceVectorDocumentsByFilename(
      document.sourceKey,
      document.chunks.flatMap((chunk, index) => {
        const embedding = embeddings[index]
        return embedding ? [{
        filename: document.sourceKey,
        chunk_id: index,
        content: chunk.content,
        embedding: JSON.stringify(embedding),
        updated_at: document.updatedAt,
        }] : []
      })
    )
    getBM25Index()?.replaceByFilename(
      document.sourceKey,
      document.chunks.map(chunk => chunk.content)
    )
    await updateKnowledgeSourceIndexState(document.sourceKey, {
      status: 'ready',
      indexedHash: document.contentHash,
    })
    return true
  } catch (error) {
    try {
      await updateKnowledgeSourceIndexState(document.sourceKey, {
        status: 'failed',
        indexedHash: null,
        error: error instanceof Error ? error.message : String(error),
      })
    } catch (stateError) {
      console.error('Failed to mark knowledge source as failed:', stateError)
    }
    return false
  }
}

async function drainQueue() {
  if (drainPromise) return drainPromise
  drainPromise = (async () => {
    while (pendingKeys.size > 0) {
      const settings = await getKnowledgeSettings()
      if (settings.indexPaused || !await isAutoIndexEnabled() || !await hasStructuredIndexConsent()) break
      const sourceKey = pendingKeys.values().next().value as string | undefined
      if (!sourceKey) break
      pendingKeys.delete(sourceKey)
      // DA-2 (K-05): one bad source must not kill the queue; the
      // loop continues with the next key after logging.
      try {
        const document = await getKnowledgeSourceDocument(sourceKey)
        if (!document) {
          // DA-2 (K-08): the kind delete runs first so the source
          // row is always removed; vector cleanup is best-effort.
          await deleteKnowledgeSource(sourceKey)
          try {
            await deleteVectorDocumentsByFilename(sourceKey)
          } catch (cleanupError) {
            console.error('Vector cleanup failed for removed source:', cleanupError)
          }
          continue
        }
        if (!isKnowledgeSourceEnabled(document, settings)) {
          await registerDocument(document)
          continue
        }
        await indexKnowledgeDocument(document)
      } catch (error) {
        console.error(`Knowledge indexing failed for ${sourceKey}:`, error)
      }
    }
  })().finally(() => {
    drainPromise = null
  })
  return drainPromise
}

export function enqueueKnowledgeSourceIndex(sourceKey: string) {
  void import('@/lib/wiki/queue').then(({ enqueueWikiSource }) => enqueueWikiSource(sourceKey))
    .catch(error => console.error('Failed to schedule Wiki source:', error))
  pendingKeys.add(sourceKey)
  void drainQueue().catch(error => console.error('Knowledge index queue failed:', error))
}

export async function removeKnowledgeSourceIndex(sourceKey: string) {
  pendingKeys.delete(sourceKey)
  const { removeWikiSource } = await import('@/lib/wiki/queue')
  await removeWikiSource(sourceKey)
  // DA-2 (K-08): delete the source row (healthy kind) first; the
  // legacy vector cleanup is best-effort so a cleanup failure can
  // no longer leave a ghost knowledge_sources row behind.
  await deleteKnowledgeSource(sourceKey)
  try {
    await deleteVectorDocumentsByFilename(sourceKey)
  } catch (cleanupError) {
    console.error('Vector cleanup failed for removed source:', cleanupError)
  }
}

export async function resumeKnowledgeIndexQueue() {
  // An app exit can leave a source in `indexing` after the in-memory task was lost.
  // Treat it as resumable work on the next startup instead of leaving progress stuck forever.
  const sources = await getKnowledgeSources({ statuses: ['pending', 'failed', 'indexing'] })
  sources.forEach(source => pendingKeys.add(source.sourceKey))
  await drainQueue()
}

export async function processStructuredKnowledgeSources(
  onProgress?: (current: number, total: number, title: string) => void
) {
  const documents = [
    ...await collectRecordKnowledgeDocuments(),
    ...await collectCanvasKnowledgeDocuments(),
  ]
  let success = 0
  let failed = 0
  let paused = false
  for (let index = 0; index < documents.length; index++) {
    const document = documents[index]
    const settings = await getKnowledgeSettings()
    if (settings.indexPaused) {
      paused = true
      break
    }
    onProgress?.(index + 1, documents.length, document.title)
    if (!isKnowledgeSourceEnabled(document, settings)) {
      await registerDocument(document)
      continue
    }
    if (await indexKnowledgeDocument(document)) success++
    else failed++
  }
  return { total: documents.length, success, failed, paused }
}

// Re-homed by F5 (wave 4, desain-sql-adapter section 5.4 row 17):
// registration runs through the SqlAdapter kind
// `knowledge.upsertSource` (status pending, no indexing, no BM25
// touch) and the consent key through the StoreAdapter. The
// document collectors still read through the @/db modules (their
// migration to kinds belongs to the F3 codemod); this function
// itself sends no raw SQL and touches no legacy database handle.
// It is not a boot step: the funnel documents it as re-homed
// outside boot init, and its owner calls it explicitly.
export async function bootstrapStructuredKnowledgeRegistry() {
  const documents = [
    ...await collectRecordKnowledgeDocuments(),
    ...await collectCanvasKnowledgeDocuments(),
  ]
  const adapter = platform.sql
  for (const document of documents) {
    await adapter.execute({
      kind: 'knowledge.upsertSource',
      source: {
        sourceKey: document.sourceKey,
        sourceType: document.sourceType,
        sourceId: document.sourceId,
        title: document.title,
        contentHash: document.contentHash,
        indexedHash: null,
        updatedAt: document.updatedAt,
        locator: document.locator,
        status: 'pending',
        error: null,
      },
    })
  }
  const store = await platform.store.load('store.json')
  const consent = await store.get<boolean>('ragStructuredKnowledgeConsent')
  if (consent === undefined) {
    await store.set('ragStructuredKnowledgeConsent', documents.length === 0)
  }
}

export async function reconcileStructuredKnowledgeSources() {
  const documents = [
    ...await collectRecordKnowledgeDocuments(),
    ...await collectCanvasKnowledgeDocuments(),
  ]
  const currentKeys = new Set(documents.map(document => document.sourceKey))
  const registered = await getKnowledgeSources({ sourceTypes: ['record', 'canvas'] })
  for (const source of registered) {
    if (!currentKeys.has(source.sourceKey)) await removeKnowledgeSourceIndex(source.sourceKey)
  }
  for (const document of documents) {
    if (await registerDocument(document)) pendingKeys.add(document.sourceKey)
  }
  await drainQueue()
}

export async function retryKnowledgeSource(sourceKey: string) {
  const document = await getKnowledgeSourceDocument(sourceKey)
  return document ? indexKnowledgeDocument(document) : false
}

export async function purgeDisabledKnowledgeVectors() {
  const settings = await getKnowledgeSettings()
  const sources = await getKnowledgeSources()
  let purged = 0
  let failed = 0
  for (const source of sources) {
    if (!isKnowledgeSourceEnabled(source, settings)) {
      // DA-2 (K-10): a cleanup failure on one source must not
      // stop the purge or skip the status reset; count it so the
      // caller can report honestly.
      try {
        await deleteVectorDocumentsByFilename(source.sourceKey)
        purged++
      } catch (error) {
        failed++
        console.error(`Vector purge failed for ${source.sourceKey}:`, error)
      }
      await updateKnowledgeSourceIndexState(source.sourceKey, {
        status: 'pending',
        indexedHash: null,
      })
    }
  }
  return { purged, failed }
}

export async function getReadyKnowledgeVectorKeys(sourceTypes?: readonly KnowledgeSourceType[]) {
  const settings = await getKnowledgeSettings()
  const sources = await getKnowledgeSources({ sourceTypes, statuses: ['ready'] })
  return new Set(sources
    .filter(source => source.indexedHash === source.contentHash && isKnowledgeSourceEnabled(source, settings))
    .map(source => source.sourceKey))
}

export async function hydrateArticleKnowledgeRegistry() {
  const sources = await getKnowledgeSources({ sourceTypes: ['article'] })
  for (const source of sources) {
    const docs = await getVectorDocumentsByFilename(source.sourceKey)
    if (docs.length === 0 && source.status === 'ready') {
      await updateKnowledgeSourceIndexState(source.sourceKey, { status: 'pending', indexedHash: null })
    }
  }
}
