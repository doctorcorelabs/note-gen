// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Wiki persistence client, migrated to typed catalog kinds
// (UTANG-UJI-09). The legacy `db` facade always rejects in web
// mode, so every read and write below goes through
// getSqlAdapter() with `wiki.*` kinds from ops-catalog.ts.
// Schema creation (the old initWikiDb CREATE TABLE block) is
// gone: the server owns the wiki tables.
//
// Wave reality, stated plainly: the ten read kinds are W1 with
// real server handlers, so reads work in Fase 1. The seven
// write kinds are W2 stubs that answer UNAVAILABLE in Fase 1
// (handler and consumer land with the Fase 2 wiki engine), so
// writes fail explicitly with a typed adapter error instead of
// the legacy facade throw. Dirty bookkeeping is server-side:
// wiki.upsertSource, wiki.commitRevision, and wiki.upsertPage
// set the dirty flag in the same transaction, and wiki.putMeta
// with key 'dirty' = true advances dirty-version (catalog
// comments at the kind definitions).
//
// Known catalog gaps, recorded instead of hidden:
// - No kind inserts a standalone revision row; only
//   wiki.commitRevision writes revisions. cacheWikiMarkdown-
//   Document therefore cannot persist the revision payload.
// - No kind deletes a page or revision row, so
//   removeWikiMarkdownCache cannot remove those rows yet.
// - No kind clears the dirty flag conditionally on
//   dirty-version, so markWikiSynced checks the version with
//   a read before writing (not atomic).
// All three gaps are unreachable in Fase 1 because the first
// write of each function already answers UNAVAILABLE.

import { getSqlAdapter } from './index'
import type { SqlJsonValue } from '@/lib/platform/sql/ops-catalog'
import type {
  WikiJob, WikiPage, WikiSegmentCache, WikiSourceRevision,
  WikiSourceState, WikiUsage,
} from '@/types/wiki'

export function emitWikiUpdated() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('wiki-updated'))
}

export async function getWikiMeta<T>(contextId: string, key: string): Promise<T | null> {
  const row = await getSqlAdapter().queryOne({ kind: 'wiki.getMeta', contextId, key })
  return (row ?? null) as unknown as T | null
}

export async function setWikiMeta<T>(contextId: string, key: string, value: T) {
  // Dirty semantics (key 'dirty' = true also advances
  // dirty-version) are applied by the server handler.
  await getSqlAdapter().execute({
    kind: 'wiki.putMeta', contextId, key, value: value as unknown as SqlJsonValue,
  })
}

export async function getWikiSourceState(contextId: string, stableId: string) {
  return await getSqlAdapter().queryOne({ kind: 'wiki.getSourceState', contextId, stableId })
}

export function listWikiSourceStates(contextId: string) {
  return getSqlAdapter().query({ kind: 'wiki.listSourceStates', contextId })
}

export async function upsertWikiSourceState(state: WikiSourceState) {
  // The server sets the dirty flag in the same transaction.
  await getSqlAdapter().execute({ kind: 'wiki.upsertSource', state })
  emitWikiUpdated()
}

export async function getWikiRevision(contextId: string, id: string) {
  return await getSqlAdapter().queryOne({ kind: 'wiki.getRevision', contextId, id })
}

export async function findWikiRevision(contextId: string, inputHash: string) {
  return await getSqlAdapter().queryOne({ kind: 'wiki.findRevisionByInputHash', contextId, inputHash })
}

export function getActiveWikiRevisions(contextId: string) {
  // The server handler performs the same two-step join and
  // payload filtering the legacy client did.
  return getSqlAdapter().query({ kind: 'wiki.getActiveRevisions', contextId })
}

/** Persist Markdown first; the server stores the disposable projection and job guard. */
export async function commitWikiSourceRevision(
  revision: WikiSourceRevision, pages: WikiPage[], expectedVersion?: number,
): Promise<boolean> {
  const { writeWikiPageFile } = await import('@/lib/wiki/files')
  const persistedPages: WikiPage[] = []
  for (const page of pages) persistedPages.push(await writeWikiPageFile(page, revision))
  // Guard (current state exists, contentHash matches, status
  // not deleted/excluded/unavailable, expectedVersion match)
  // is enforced server-side; a guard miss answers
  // committed: false instead of throwing.
  const result = await getSqlAdapter().execute({
    kind: 'wiki.commitRevision', revision, pages: persistedPages, expectedVersion,
  })
  if (result.committed) emitWikiUpdated()
  return result.committed
}

export async function getWikiPage(contextId: string, id: string) {
  return await getSqlAdapter().queryOne({ kind: 'wiki.getPage', contextId, id })
}

export function listWikiPages(contextId: string) {
  return getSqlAdapter().query({ kind: 'wiki.listPages', contextId })
}

export async function upsertWikiPage(page: WikiPage) {
  const { writeWikiPageFile } = await import('@/lib/wiki/files')
  page = await writeWikiPageFile(page)
  // The server sets the dirty flag in the same transaction.
  await getSqlAdapter().execute({ kind: 'wiki.upsertPage', page })
  emitWikiUpdated()
}

export function listWikiJobs(contextId: string) {
  return getSqlAdapter().query({ kind: 'wiki.listJobs', contextId })
}

export async function upsertWikiJob(job: WikiJob) {
  await getSqlAdapter().execute({ kind: 'wiki.upsertJob', job })
  emitWikiUpdated()
}

export async function removeWikiJob(contextId: string, id: string, expectedInputHash?: string) {
  // Guarded removal is server-side: an expectedInputHash
  // mismatch is a silent no-op.
  await getSqlAdapter().execute({ kind: 'wiki.removeJob', contextId, id, expectedInputHash })
  emitWikiUpdated()
}

export async function getWikiSegmentCache(contextId: string, key: string) {
  return await getSqlAdapter().queryOne({ kind: 'wiki.getSegment', contextId, key })
}

export async function saveWikiSegmentCache(contextId: string, key: string, value: WikiSegmentCache) {
  await getSqlAdapter().execute({ kind: 'wiki.putSegment', contextId, key, value })
}

let usageQueue: Promise<void> = Promise.resolve()
export function recordWikiUsage(contextId: string, usage: WikiUsage): Promise<void> {
  const update = async () => {
    const current = await getWikiUsage(contextId)
    await setWikiMeta(contextId, 'usage', {
      inputTokens: current.inputTokens + usage.inputTokens,
      outputTokens: current.outputTokens + usage.outputTokens,
      estimated: current.estimated || usage.estimated,
    })
    emitWikiUpdated()
  }
  usageQueue = usageQueue.then(update, update)
  return usageQueue
}

export async function getWikiUsage(contextId: string): Promise<WikiUsage> {
  return await getWikiMeta<WikiUsage>(contextId, 'usage')
    ?? { inputTokens: 0, outputTokens: 0, estimated: false }
}

export async function getWikiSyncDirty(contextId: string) {
  return await getWikiMeta<boolean>(contextId, 'dirty') ?? false
}

export async function markWikiSynced(contextId: string, expectedVersion?: number) {
  // No catalog kind clears dirty conditionally on
  // dirty-version; check the version with a read, then clear
  // it with putMeta. Not atomic (see header note).
  const version = expectedVersion ?? await getWikiMeta<number>(contextId, 'dirty-version') ?? 0
  const current = await getWikiMeta<number>(contextId, 'dirty-version') ?? 0
  if (current !== version) return
  await setWikiMeta(contextId, 'dirty', false)
}

/** Cache a parsed Markdown document. This must never write back to the file. */
export async function cacheWikiMarkdownDocument(
  page: WikiPage, revision?: WikiSourceRevision, originalAvailable = true,
): Promise<WikiSourceState | null> {
  const previous = await getWikiPage(page.contextId, page.id)
  const ops: Array<
    | { kind: 'wiki.upsertPage'; page: WikiPage }
    | { kind: 'wiki.upsertSource'; state: WikiSourceState }
  > = []
  let sourceState: WikiSourceState | null = null
  if (JSON.stringify(previous) !== JSON.stringify(page)) {
    ops.push({ kind: 'wiki.upsertPage', page })
  }
  if (revision) {
    // No catalog kind inserts a standalone revision row (only
    // wiki.commitRevision writes revisions), so the revision
    // payload itself is not persisted here; see header note.
    const current = await getWikiSourceState(page.contextId, revision.source.stableId)
    sourceState = current
    // A newer local source save takes precedence over an older synchronized Wiki.
    const hasNewerSource = current && current.contentHash !== revision.source.contentHash
      && ['pending', 'processing', 'failed'].includes(current.status)
    const localJob = current && ['pending', 'failed'].includes(current.status)
      ? (await listWikiJobs(page.contextId)).find(job => job.id === `source:${revision.source.stableId}`) ?? null
      : null
    const guarded = current?.status === 'processing' || current?.status === 'deleted'
      || ((current?.status === 'pending' || current?.status === 'failed') && page.status !== 'ready')
      || (localJob && localJob.inputHash !== revision.inputHash)
    if (!hasNewerSource && !guarded) {
      const next: WikiSourceState = {
        contextId: page.contextId, stableId: revision.source.stableId,
        sourceKey: revision.source.sourceKey, sourceType: revision.source.sourceType,
        source: revision.source, contentHash: revision.source.contentHash,
        status: page.status === 'archived' ? 'excluded' : originalAvailable ? 'ready' : 'unavailable',
        revisionId: revision.id, version: current?.version ?? 0,
        updatedAt: page.updatedAt, error: null,
      }
      const changed = !current || JSON.stringify({ ...current, version: 0 }) !== JSON.stringify({ ...next, version: 0 })
      if (changed) {
        // The legacy atomic version guard (where version = $9)
        // has no catalog equivalent; the upsert is unguarded.
        // Cache parsing runs beside the source queue, so a
        // source that became pending/processing meanwhile can
        // be overwritten; recorded in the header note.
        ops.push({ kind: 'wiki.upsertSource', state: { ...next, version: (current?.version ?? 0) + 1 } })
      }
    }
  }
  if (ops.length) await getSqlAdapter().transaction(ops)
  if (revision) sourceState = await getWikiSourceState(page.contextId, revision.source.stableId)
  if (JSON.stringify(previous) !== JSON.stringify(page)) emitWikiUpdated()
  return sourceState
}

/** Removing a Markdown document also removes its searchable cached body. */
export async function removeWikiMarkdownCache(contextId: string, pageId: string, expectedInputHash?: string) {
  const page = await getWikiPage(contextId, pageId)
  if (!page || (expectedInputHash !== undefined && page.inputHash !== expectedInputHash)) return
  // No catalog kind deletes page or revision rows yet, so
  // those rows cannot be removed here (see header note). The
  // source-state updates below still run so sources stop
  // pointing at the removed document.
  const ops: Array<{ kind: 'wiki.upsertSource'; state: WikiSourceState }> = []
  if (page.kind === 'source') for (const source of page.sourceRefs) {
    const state = await getWikiSourceState(contextId, source.stableId)
    const job = (await listWikiJobs(contextId)).find(entry => entry.id === `source:${source.stableId}`) ?? null
    const newerWork = state && ['pending', 'processing', 'failed'].includes(state.status)
      && (!job || job.inputHash !== page.inputHash)
    if (state && state.contentHash === source.contentHash && !newerWork) {
      ops.push({ kind: 'wiki.upsertSource', state: { ...state, status: 'unavailable', revisionId: null,
        version: state.version + 1, updatedAt: Date.now(), error: null } })
    }
  }
  if (ops.length) await getSqlAdapter().transaction(ops)
  emitWikiUpdated()
}
