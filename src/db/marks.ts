// Record storage (upstream `src/db/marks.ts`), migrated to typed
// catalog kinds in wave 5 (D-DEMO-3, W5-CONTROLTEXT), following the
// `src/db/tags.ts` wave 4 precedent: reads and single writes go
// through `getSqlAdapter()`, and the legacy `getDb` handle is kept
// only for the four functions no kind can express (see their
// NOT-migrated notes). The ControlText save path (`insertMark`
// plus the completion reads) runs entirely on kinds; before this
// migration every save rejected because `getDb()` always throws
// since V3-14 removed raw SQL access.

import emitter from '@/lib/emitter'
import { getDb, getSqlAdapter } from "./index"
import { getTags, normalizeTagName } from './tags'
import { platform, BaseDirectory } from "@/lib/platform"
import { enqueueAutoDataSync } from '@/lib/sync/auto-data-sync-queue'
import {
  getMarkLocalAssetPath,
  getMarkLocalAssetPaths,
  queueRecordAssetRemoteDeletions,
} from '@/lib/sync/record-assets'
import { getRecordImageThumbnailPath } from '@/lib/record-image-thumbnail'
import { recordTagIds } from '@/lib/record-tags'
import type { SqlDeletedFilter, SqlMarkPatch, SqlMarkRow } from '../lib/platform/sql/ops-catalog'

export { getMarkLocalAssetPath }

export interface Mark {
  id: number
  tagId: number
  /** The primary tag remains tagId for compatibility with chats and save targets. */
  tagIds?: number[]
  tagUpdatedAt?: number
  /** Row version from the kind row. Present on every record read through
   *  this module; required by updateMark/updateMarkTag/updateMarks as the
   *  optimistic guard (DA-11-08). Absent only on rows built by hand. */
  version?: number
  type: 'scan' | 'text' | 'image' | 'link' | 'file' | 'recording' | 'todo'
  content?: string
  desc?: string
  url: string
  deleted: 0 | 1
  createdAt: number
  sourceId?: string | null
}

// Only the unmigrated bulk upsert below still reads through this
// column list; every migrated reader maps kind rows instead.
const MARK_COLUMNS = 'id, tagId, type, content, url, desc, deleted, createdAt, sourceId'

// Match the exact tag or its descendants; substr avoids LIKE wildcard surprises.
// Kept for the unmigrated plugin records module, which still builds SQL
// against it; no migrated function in this file executes it.
export const RECORD_TAG_MATCH_SQL = `marks.tagId = $1 or exists (
  select 1 from tags candidate join tags parent on parent.id = $1
  where (candidate.id = parent.id or substr(candidate.name, 1, length(parent.name) + 1) = parent.name || '/')
  and (candidate.id = marks.tagId or exists (
    select 1 from record_tag_metadata metadata, json_each(metadata.tagIds) related
    where metadata.markId = marks.id and related.value = candidate.id
  ))
)`

// Migrated in wave 5 (D-DEMO-3): kind rows already carry the
// effective tag set, so attaching it is a pure mapping now. Rows
// without tag metadata fall back to the primary tag, as upstream
// did when no metadata row existed; `tagUpdatedAt` keeps the row
// value, or 0 when the row carries none.
export async function attachMarkTagIds(marks: Mark[]): Promise<Mark[]> {
  return marks.map(mark => ({ ...mark, tagIds: recordTagIds(mark), tagUpdatedAt: mark.tagUpdatedAt ?? 0 }))
}

/** Omitted metadata means preserve existing tags, not clear them. One statement is atomic. */
export async function saveMarkTagIds(markId: number, tagId: number, tagIds?: number[], updatedAt = 0) {
  // Migrated to kind `marks.saveTagIds` in wave 5 (D-DEMO-3). The
  // early return preserves the upstream preserve-no-op exactly: no
  // call is sent when the caller passed no set. The `updatedAt`
  // argument is dropped: the kind refreshes `tag_updated_at`
  // server-side and accepts no caller timestamp, so a sync apply
  // cannot preserve the remote timestamp through this function.
  // Unlike upstream, a missing mark answers 404 and unknown tag
  // ids answer 400 instead of writing silently.
  if (!Array.isArray(tagIds)) return
  void updatedAt
  await getSqlAdapter().execute({
    kind: 'marks.saveTagIds',
    id: markId,
    tagId,
    tagIds: recordTagIds({ tagId, tagIds }),
  })
}

/** Tag-only edits never write a stale copy of the record's content. */
export async function updateRecordTags(id: number, tagIds: number[], expectedTagIds?: number[], newNames: string[] = [], expectedPrimary?: number) {
  // Migrated to kind `marks.updateTags` in wave 5 (D-DEMO-3). The
  // handler carries the upstream semantics: the set guard, new tag
  // creation from names, and primary preservation. The kind
  // enforces its own new-name limits (at most 10 names, each at
  // most 100 characters); a mark whose primary tag no longer
  // exists answers 400 when no other valid tag or new name is
  // supplied. A guard miss answers 409 instead of writing.
  const mark = await getMarkById(id)
  if (!mark || mark.deleted) throw new Error('Record not found')
  const tags = await getTags()
  const valid = new Set(tags.map(tag => tag.id))
  const next = recordTagIds({ tagId: mark.tagId, tagIds: tagIds.filter(tagId => valid.has(tagId)) })
  const expected = expectedTagIds || recordTagIds(mark)
  const names = [...new Set(newNames.map(normalizeTagName))]
  await getSqlAdapter().execute({
    kind: 'marks.updateTags',
    id,
    tagIds: next,
    ...(names.length > 0 ? { newNames: names } : {}),
    expected: { tagIds: [...expected].sort((a, b) => a - b), primaryTagId: expectedPrimary ?? mark.tagId },
  })
  enqueueRecordsAutoSync('mark:update-tags')
  await invalidateMarkKnowledgeIndex(id).catch(error => console.error('Record index invalidation failed:', error))
  enqueueMarkKnowledgeIndex(id)
}

async function deleteMarkLocalAsset(assetPath: string) {
  const fileExists = await platform.fs.exists(assetPath, { baseDir: BaseDirectory.AppData })
  if (!fileExists) {
    return
  }

  await platform.fs.remove(assetPath, { baseDir: BaseDirectory.AppData })
}

async function deleteMarkLocalAssets(marks: Pick<Mark, 'type' | 'url' | 'content'>[]) {
  const assetPaths = Array.from(new Set(marks.flatMap(getMarkLocalAssetPaths)))
  for (const assetPath of assetPaths) {
    try {
      await deleteMarkLocalAsset(assetPath)
    } catch (error) {
      console.error('Error deleting mark local asset:', assetPath, error)
    }
  }
}

function enqueueRecordsAutoSync(reason: string) {
  enqueueAutoDataSync('records', reason)
  emitter.emit('plugin-records-changed')
}

function enqueueMarkKnowledgeIndex(id?: number | null) {
  if (!id) return
  void import('@/lib/knowledge-index').then(({ enqueueKnowledgeSourceIndex }) => {
    enqueueKnowledgeSourceIndex(`record:${id}`)
  })
}

async function invalidateMarkKnowledgeIndex(id: number) {
  // Migrated to kind `knowledge.updateStatus` in wave 5 (D-DEMO-3):
  // status pending with a cleared hash and error, exactly the
  // upstream row update. A missing source answers affected 0, so
  // the first-init case needs no special handling. Failures stay
  // swallowed, as upstream: invalidation must never fail the
  // record write that preceded it.
  try {
    await getSqlAdapter().execute({
      kind: 'knowledge.updateStatus',
      sourceKey: `record:${id}`,
      update: { status: 'pending', indexedHash: null, error: null },
    })
  } catch {
    // The knowledge registry may not exist yet on first init.
  }
}

async function removeMarkKnowledgeIndex(id: number) {
  // Best-effort: the knowledge and vector modules are still on the
  // legacy database facade, which throws in web mode, so removal
  // cannot complete until those modules migrate. The record write
  // has already succeeded; index cleanup must not fail the delete.
  // The attempt is kept (not replaced by a direct kind call) so
  // cleanup starts working, wiki and vector included, the moment
  // those modules migrate, with no change here.
  try {
    const { removeKnowledgeSourceIndex } = await import('@/lib/knowledge-index')
    await removeKnowledgeSourceIndex(`record:${id}`)
  } catch (error) {
    console.error('Record index removal failed:', error)
  }
}

function reconcileRecordKnowledgeIndex() {
  void import('@/lib/knowledge-index').then(({ reconcileStructuredKnowledgeSources }) => {
    void reconcileStructuredKnowledgeSources()
  })
}


// 创建 marks 表
export async function initMarksDb() {
  const isExist = await platform.fs.exists('screenshot', { baseDir: BaseDirectory.AppData})
  if (!isExist) {
    await platform.fs.mkdir('screenshot', { baseDir: BaseDirectory.AppData})
  }
  const isImageDirExist = await platform.fs.exists('image', { baseDir: BaseDirectory.AppData })
  if (!isImageDirExist) {
    await platform.fs.mkdir('image', { baseDir: BaseDirectory.AppData })
  }
  const isRecordingDirExist = await platform.fs.exists('recordings', { baseDir: BaseDirectory.AppData })
  if (!isRecordingDirExist) {
    await platform.fs.mkdir('recordings', { baseDir: BaseDirectory.AppData })
  }
}

// Kind rows carry `deleted` as a boolean and always include the
// effective tag set; map them onto the legacy `Mark` shape callers
// read (`deleted` 0 | 1, `tagIds` present, `tagUpdatedAt` 0 when
// the mark never had its tag set written).
function toMark(row: SqlMarkRow): Mark {
  return {
    id: row.id,
    tagId: row.tagId,
    tagIds: recordTagIds({ tagId: row.tagId, tagIds: row.tagIds }),
    tagUpdatedAt: row.tagUpdatedAt,
    version: row.version,
    type: row.type,
    content: row.content,
    desc: row.desc,
    url: row.url,
    deleted: row.deleted ? 1 : 0,
    createdAt: row.createdAt,
    sourceId: row.sourceId ?? null,
  }
}

// Upstream previews truncate content and desc to 500 characters in
// SQL; kind rows carry full content, so truncate client-side with
// code-point slicing to match SQLite substr semantics.
function truncatePreview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  return Array.from(text).slice(0, 500).join('')
}

function toPreviewMark(row: SqlMarkRow): Mark {
  const mark = toMark(row)
  return { ...mark, content: truncatePreview(mark.content), desc: truncatePreview(mark.desc) }
}

// List kinds page at most 200 rows; the legacy readers return the
// whole collection, so page to exhaustion. The cursor is derived
// from the last row, `<createdAtMs>:<id>`, per the handler contract.
const MARK_LIST_PAGE_SIZE = 200

async function listAllMarkRows(deleted: SqlDeletedFilter): Promise<SqlMarkRow[]> {
  const rows: SqlMarkRow[] = []
  let cursor: string | undefined
  let hasMore = true
  while (hasMore) {
    const page = await getSqlAdapter().query({
      kind: 'marks.list',
      deleted,
      ...(cursor === undefined ? {} : { cursor }),
      limit: MARK_LIST_PAGE_SIZE,
    })
    rows.push(...page)
    if (page.length < MARK_LIST_PAGE_SIZE) {
      hasMore = false
    } else {
      const last = page[page.length - 1]
      cursor = `${last.createdAt}:${last.id}`
    }
  }
  return rows
}

async function listAllMarkRowsByTag(tagId: number, deleted: SqlDeletedFilter): Promise<SqlMarkRow[]> {
  const rows: SqlMarkRow[] = []
  let cursor: string | undefined
  let hasMore = true
  while (hasMore) {
    const page = await getSqlAdapter().query({
      kind: 'marks.listByTag',
      tagId,
      deleted,
      ...(cursor === undefined ? {} : { cursor }),
      limit: MARK_LIST_PAGE_SIZE,
    })
    rows.push(...page)
    if (page.length < MARK_LIST_PAGE_SIZE) {
      hasMore = false
    } else {
      const last = page[page.length - 1]
      cursor = `${last.createdAt}:${last.id}`
    }
  }
  return rows
}

// Map a kind write result onto the legacy shape unmigrated callers
// read (`rowsAffected`, `lastInsertId`), as `tags.ts` does.
function toLegacyWriteResult(result: { affected: number; id?: number | string; version?: number }) {
  // T-02-01: carry the version the server returned for a guarded
  // write, so the store can adopt it for the next sequential write.
  return { rowsAffected: result.affected, lastInsertId: result.id as number, version: result.version }
}

// Patch for `marks.update` from a full legacy row. `createdAt` is
// not patchable: the fork preserves creation time, unlike upstream
// `updateMark`, which rewrote it from the passed row.
function toMarkPatch(mark: Mark): SqlMarkPatch {
  const patch: SqlMarkPatch = { tagId: mark.tagId, url: mark.url }
  if (mark.desc !== undefined) patch.desc = mark.desc
  if (mark.content !== undefined) patch.content = mark.content
  return patch
}

export async function getMarks(id: number) {
  // Migrated to kind `marks.listByTag` in wave 5 (D-DEMO-3). The
  // handler carries the upstream tag match (tag subtree plus
  // metadata tag sets, server-side). `deleted: 'all'` is
  // load-bearing: upstream applied no deleted filter here and the
  // mark store filters deleted rows client-side.
  const rows = await listAllMarkRowsByTag(id, 'all')
  return rows.map(toMark)
}

export async function getMarkPreviews(id?: number) {
  // Migrated to kinds `marks.list` / `marks.listByTag` in wave 5
  // (D-DEMO-3), active rows only, matching the upstream
  // `deleted = 0` filter. The 500-character truncation moves
  // client-side; kind rows carry full content.
  const rows = id === undefined
    ? await listAllMarkRows('active')
    : await listAllMarkRowsByTag(id, 'active')
  return rows.map(toPreviewMark)
}

export async function getTrashMarkPreviews() {
  // Migrated to kind `marks.list` with `deleted: 'deleted'` in
  // wave 5 (D-DEMO-3), with the upstream 500-character truncation
  // applied client-side.
  const rows = await listAllMarkRows('deleted')
  return rows.map(toPreviewMark)
}

export async function getMarkById(id: number) {
  // Migrated to kind `marks.get` in wave 5 (D-DEMO-3). The handler
  // returns deleted rows too, matching upstream; a missing row
  // answers an empty set, mapped to `undefined` as before.
  const row = await getSqlAdapter().queryOne({ kind: 'marks.get', id })
  return row === null ? undefined : toMark(row)
}

export async function getActiveMarkPage(options: { tagId?: number; offset: number; limit: number }): Promise<{ marks: Mark[]; hasMore: boolean }> {
  // Paged active-mark read for the plugin records module
  // (DATA2D-3): same kinds and order as getMarks/getMarkPreviews
  // (createdAt descending, id tiebreak via the cursor), paged
  // until the requested window plus one lookahead row is
  // collected. Rows carry the version, like every read here.
  const want = options.offset + options.limit + 1
  const rows: SqlMarkRow[] = []
  let cursor: string | undefined
  while (rows.length < want) {
    const page = options.tagId === undefined
      ? await getSqlAdapter().query({
        kind: 'marks.list',
        deleted: 'active',
        ...(cursor === undefined ? {} : { cursor }),
        limit: MARK_LIST_PAGE_SIZE,
      })
      : await getSqlAdapter().query({
        kind: 'marks.listByTag',
        tagId: options.tagId,
        deleted: 'active',
        ...(cursor === undefined ? {} : { cursor }),
        limit: MARK_LIST_PAGE_SIZE,
      })
    rows.push(...page)
    if (page.length < MARK_LIST_PAGE_SIZE) break
    const last = page[page.length - 1]
    cursor = `${last.createdAt}:${last.id}`
  }
  const window = rows.slice(options.offset, options.offset + options.limit)
  return { marks: window.map(toMark), hasMore: rows.length > options.offset + options.limit }
}

// DA-11-08: every marks.update from this module carries the version
// the caller loaded, exactly like the web detail's expectedVersion.
// A missing version fails closed instead of overwriting silently;
// callers must read the record first. The fresh row read inside
// updateMark exists only for the asset comparison and is never used
// as the guard: guarding on a just-read version would be vacuous
// (the DA-11-09 pattern) and would hide concurrent edits.
function requireMarkVersion(version: number | undefined, id: number): number {
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    throw new Error(`updateMark needs mark.version for record ${id} (read the record first); refusing an unguarded overwrite.`)
  }
  return version
}

// A guarded kind write answers a stale expected version with a
// CONFLICT adapter error (wire code revision_conflict, status 409).
// Recognition is structural, like records-kind-client: the error
// classes live in platform implementation files this module does
// not import. For `marks.update` the only conflict is the stale
// version guard, so the CONFLICT code is decisive here.
export function isMarkRevisionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const shape = error as Error & Record<string, unknown>
  if (shape.code === 'CONFLICT') return true
  const details = shape.details
  if (typeof details === 'object' && details !== null) {
    const record = details as Record<string, unknown>
    if (record.wireCode === 'revision_conflict' || record.status === 409) return true
  }
  return false
}

export async function updateMarkTag(id: number, tagId: number, expectedVersion?: number) {
  // Migrated to kind `marks.update` in wave 5 (D-DEMO-3). Moving
  // the primary tag keeps the additional tags, per design 1.3
  // rule 3; the handler answers 400 when the new primary names no
  // tag in the workspace. Guarded (DA-11-08): the caller passes
  // the version it loaded; a missing version fails closed.
  const version = requireMarkVersion(expectedVersion, id)
  const result = await getSqlAdapter().execute({ kind: 'marks.update', id, patch: { tagId }, expected: { version } })
  enqueueRecordsAutoSync('mark:update-tag')
  await invalidateMarkKnowledgeIndex(id)
  enqueueMarkKnowledgeIndex(id)
  return toLegacyWriteResult(result)
}

export async function insertMark(mark: Partial<Mark>, beforeWrite?: () => Promise<void>) {
  // Migrated to kind `marks.create` in wave 5 (D-DEMO-3). The
  // handler writes the mark row, its tag set, and one record
  // activity event in a single transaction, replacing the
  // upstream insert plus `saveMarkTagIds` plus `insertActivityEvent`
  // (the server derives the event title and description exactly as
  // upstream did, so no `activity` argument is sent). The `url`
  // default follows the kind client: the kind requires a string,
  // and text captures pass no url. A caller-supplied `sourceId`
  // is first-write-wins: an existing row answers affected
  // 0 with the existing id instead of inserting a duplicate.
  await beforeWrite?.()
  if (mark.tagId === undefined || mark.type === undefined) {
    throw new Error('insertMark requires tagId and type')
  }
  const result = await getSqlAdapter().execute({
    kind: 'marks.create',
    mark: {
      tagId: mark.tagId,
      type: mark.type,
      ...(typeof mark.content === 'string' ? { content: mark.content } : {}),
      ...(typeof mark.desc === 'string' ? { desc: mark.desc } : {}),
      url: mark.url ?? '',
      ...(mark.sourceId ? { sourceId: mark.sourceId } : {}),
    },
    ...(Array.isArray(mark.tagIds) ? { tagIds: recordTagIds({ tagId: mark.tagId, tagIds: mark.tagIds }) } : {}),
  })

  const localImagePath = mark.type && mark.url
    ? getMarkLocalAssetPath({ type: mark.type, url: mark.url })
    : null
  if (localImagePath) {
    await getRecordImageThumbnailPath(localImagePath, 96)
  }

  const legacyResult = toLegacyWriteResult(result)
  enqueueRecordsAutoSync('mark:insert')
  enqueueMarkKnowledgeIndex(legacyResult.lastInsertId)

  return legacyResult
}

export async function insertExternalMark(mark: Partial<Mark> & { sourceId: string }) {
  // Migrated in wave 5 (D-DEMO-3): `marks.create` is
  // first-write-wins on `sourceId`, so the existence
  // pre-check and the race re-select are both replaced by one
  // insert plus a read-back. `affected` 0 means the sourceId
  // already named a row, which is returned with `duplicate: true`
  // and left unchanged.
  const result = await insertMark(mark)
  const inserted = result.lastInsertId ? await getMarkById(result.lastInsertId) : undefined
  if (!inserted) {
    throw new Error('Failed to load the saved external record')
  }
  return { mark: inserted, duplicate: result.rowsAffected === 0 }
}

export async function getAllMarks() {
  // Migrated to kind `marks.list` in wave 5 (D-DEMO-3).
  // `deleted: 'all'`: upstream applied no deleted filter and the
  // trash view filters client-side.
  const rows = await listAllMarkRows('all')
  return rows.map(toMark)
}

export async function updateMark(mark: Mark) {
  // Migrated to kind `marks.update` in wave 5 (D-DEMO-3). The
  // previous row is read back for the asset comparison, as
  // upstream; a missing or soft-deleted row answers 404 from the
  // handler instead of writing zero rows silently. Guarded
  // (DA-11-08): the write carries mark.version, the version the
  // editing surface loaded, and a 409 surfaces to the caller
  // instead of overwriting a concurrent edit.
  const version = requireMarkVersion(mark.version, mark.id)
  const previous = await getMarkById(mark.id)
  const result = await getSqlAdapter().execute({ kind: 'marks.update', id: mark.id, patch: toMarkPatch(mark), expected: { version } })
  if (
    previous &&
    JSON.stringify(getMarkLocalAssetPaths(previous).sort())
      !== JSON.stringify(getMarkLocalAssetPaths(mark).sort())
  ) {
    await queueRecordAssetRemoteDeletions([previous])
  }
  enqueueRecordsAutoSync('mark:update')
  await invalidateMarkKnowledgeIndex(mark.id)
  enqueueMarkKnowledgeIndex(mark.id)
  return toLegacyWriteResult(result)
}

export async function restoreMark(id: number) {
  // Migrated to kind `marks.restore` in wave 5 (D-DEMO-3).
  // `createdAt` is no longer rewritten: the fork keeps creation
  // time immutable. A missing row answers 404 instead of writing
  // zero rows silently.
  const result = await getSqlAdapter().execute({ kind: 'marks.restore', id })
  enqueueRecordsAutoSync('mark:restore')
  enqueueMarkKnowledgeIndex(id)
  return toLegacyWriteResult(result)
}

export async function delMark(id: number) {
  // Migrated to kind `marks.softDelete` in wave 5 (D-DEMO-3). The
  // legacy `deleted` column check and `createdAt` rewrite are
  // gone: the schema is server-owned and creation time is
  // immutable. A missing row answers 404; upstream threw a
  // TypeError reading the missing row.
  const result = await getSqlAdapter().execute({ kind: 'marks.softDelete', id })
  enqueueRecordsAutoSync('mark:delete')
  await removeMarkKnowledgeIndex(id)
  return toLegacyWriteResult(result)
}

export async function deleteAllMarks() {
  // NOT migrated in wave 5 (D-DEMO-3): no kind deletes every mark
  // row, and a per-record loop cannot reproduce the single
  // upstream delete. The function has no callers in the tree and
  // is kept for API stability; it still fails loudly through
  // `getDb` until a kind or REST route lands.
  const db = await getDb();
  const marks = await getAllMarks()
  const result = await db.execute("delete from marks")
  enqueueRecordsAutoSync('mark:delete-all')
  await Promise.all(marks.map(mark => removeMarkKnowledgeIndex(mark.id)))
  return result
}

export async function insertMarks(marks: Partial<Mark>[]) {
  // NOT migrated in wave 5 (D-DEMO-3): no catalog kind upserts
  // marks by explicit id (restore semantics). `marks.create`
  // assigns server ids and cannot preserve restored ids. Same
  // standing as `insertTags` in `src/db/tags.ts`.
  const db = await getDb();
  try {
    for (const mark of marks) {
      if (mark.id) {
        const exists = await db.select<Mark[]>(`select ${MARK_COLUMNS} from marks where id = $1`, [mark.id])
        if (exists.length > 0) {
          const sourceId = mark.sourceId ?? exists[0]!.sourceId ?? crypto.randomUUID()
          await db.execute(
            "update marks set tagId = $1, type = $2, content = $3, url = $4, desc = $5, createdAt = $6, deleted = $7, sourceId = $8 where id = $9",
            [mark.tagId, mark.type, mark.content, mark.url, mark.desc, mark.createdAt, mark.deleted, sourceId, mark.id]
          );
          await saveMarkTagIds(mark.id, mark.tagId!, mark.tagIds, mark.tagUpdatedAt)
          continue
        }

        const sourceId = mark.sourceId ?? crypto.randomUUID()
        await db.execute(
          "insert into marks (id, tagId, type, content, url, desc, createdAt, deleted, sourceId) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [mark.id, mark.tagId, mark.type, mark.content, mark.url, mark.desc, mark.createdAt, mark.deleted, sourceId]
        );
        await saveMarkTagIds(mark.id, mark.tagId!, mark.tagIds, mark.tagUpdatedAt)
        continue
      }

      const sourceId = mark.sourceId ?? crypto.randomUUID()
      const result = await db.execute(
        "insert into marks (tagId, type, content, url, desc, createdAt, deleted, sourceId) values ($1, $2, $3, $4, $5, $6, $7, $8)",
        [mark.tagId, mark.type, mark.content, mark.url, mark.desc, mark.createdAt, mark.deleted, sourceId]
      );
      if (result.lastInsertId) await saveMarkTagIds(result.lastInsertId, mark.tagId!, mark.tagIds, mark.tagUpdatedAt)
    }
    enqueueRecordsAutoSync('mark:bulk-insert')
    reconcileRecordKnowledgeIndex()
  } catch (error) {
    console.error('Error inserting marks:', error);
    throw error;
  }
}

export async function delMarkForever(id: number) {
  // Migrated to kind `marks.deletePermanent` in wave 5 (D-DEMO-3).
  // The previous row is read for the asset cleanup, as upstream;
  // a missing row keeps the upstream silent zero-row outcome
  // (no kind call, side effects still run).
  const previous = await getMarkById(id)
  const marks = previous ? [previous] : []
  await queueRecordAssetRemoteDeletions(marks)
  await deleteMarkLocalAssets(marks)
  const result = previous
    ? await getSqlAdapter().execute({ kind: 'marks.deletePermanent', id })
    : { affected: 0, id }
  enqueueRecordsAutoSync('mark:delete-forever')
  await removeMarkKnowledgeIndex(id)
  return toLegacyWriteResult(result)
}

export async function clearTrash() {
  // Migrated to kind `marks.emptyTrash` (BUG-01): one server
  // transaction purges every soft-deleted mark plus one
  // activity event, mirroring the REST repository. The trashed
  // rows are read first for the client-side asset cleanup, as
  // upstream and as delMarkForever does; the kind result
  // `affected` is the purged count.
  const rows = await listAllMarkRows('deleted')
  const marks = rows.map(toMark)
  await queueRecordAssetRemoteDeletions(marks)
  await deleteMarkLocalAssets(marks)
  const result = await getSqlAdapter().execute({ kind: 'marks.emptyTrash' })
  enqueueRecordsAutoSync('mark:clear-trash')
  await Promise.all(marks.map(mark => removeMarkKnowledgeIndex(mark.id)))
  return toLegacyWriteResult(result)
}

export async function updateMarks(marks: Mark[]) {
  // Migrated to kind `marks.update` in wave 5 (D-DEMO-3), one call
  // per row in order, as the upstream loop. `createdAt` is no
  // longer rewritten per row. Guarded (DA-11-08): every row must
  // carry the version its caller loaded; a row without one fails
  // the whole call before any write, like updateMark.
  const guarded = marks.map(mark => ({ mark, version: requireMarkVersion(mark.version, mark.id) }))
  try {
    for (const { mark, version } of guarded) {
      await getSqlAdapter().execute({ kind: 'marks.update', id: mark.id, patch: toMarkPatch(mark), expected: { version } })
    }
    enqueueRecordsAutoSync('mark:bulk-update')
    for (const mark of marks) await invalidateMarkKnowledgeIndex(mark.id)
    reconcileRecordKnowledgeIndex()
  } catch (error) {
    console.error('Error updating marks:', error);
    throw error;
  }
}

export async function deleteMarks(ids: number[]) {
  // Migrated to kind `marks.softDelete` in wave 5 (D-DEMO-3), one
  // call per id in order, as the upstream loop. `createdAt` is no
  // longer rewritten per row.
  try {
    for (const id of ids) {
      await getSqlAdapter().execute({ kind: 'marks.softDelete', id })
    }
    enqueueRecordsAutoSync('mark:bulk-delete')
    await Promise.all(ids.map(removeMarkKnowledgeIndex))
  } catch (error) {
    console.error('Error deleting marks:', error);
    throw error;
  }
}

export async function restoreMarks(ids: number[]) {
  // Migrated to kind `marks.restore` in wave 5 (D-DEMO-3), one
  // call per id in order, as the upstream loop. `createdAt` is no
  // longer rewritten per row.
  try {
    for (const id of ids) {
      await getSqlAdapter().execute({ kind: 'marks.restore', id })
    }
    enqueueRecordsAutoSync('mark:bulk-restore')
    ids.forEach(enqueueMarkKnowledgeIndex)
  } catch (error) {
    console.error('Error restoring marks:', error);
    throw error;
  }
}

/** Guarded plugin record update: the write carries the version the plugin read, so a concurrent edit answers 409 instead of being overwritten. */
export async function updatePluginTextRecord(previous: Mark, next: Mark, beforeWrite: () => Promise<void>) {
  // Migrated to kind `marks.update` (DATA2D-3): the plugin module
  // reads through `getMarkById` (kind `marks.get`), so `previous`
  // carries the version it loaded and the write is guarded with
  // `expected: { version }` like every other marks.update in this
  // module (DA-11-08). A missing version fails closed. A stale
  // version answers 409 from the handler, mapped to `false` so
  // the plugin caller keeps its StaleRevision contract. The
  // handler also rejects a missing or soft-deleted row (404) and
  // a primary tag that names no tag in the workspace (400),
  // covering the deleted/tag-existence checks of the retired
  // full-row compare; moving the primary tag keeps the
  // additional tags, as the compare's tag-set check allowed.
  const version = requireMarkVersion(previous.version, previous.id)
  await beforeWrite()
  try {
    await getSqlAdapter().execute({ kind: 'marks.update', id: previous.id, patch: toMarkPatch(next), expected: { version } })
  } catch (error) {
    if (isMarkRevisionConflict(error)) return false
    throw error
  }
  enqueueRecordsAutoSync('mark:plugin-update')
  await invalidateMarkKnowledgeIndex(previous.id)
  enqueueMarkKnowledgeIndex(previous.id)
  return true
}
