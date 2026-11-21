import emitter from '@/lib/emitter'
import { getDb, getSqlAdapter } from "./index"
import { platform } from '@/lib/platform';
import { enqueueAutoDataSync } from '@/lib/sync/auto-data-sync-queue'
import { normalizeTagBoolean, invalidateLocalTagSyncIdentity } from '@/lib/tag-sync'

export interface Tag {
  id: number
  name: string
  isLocked?: boolean
  isPin?: boolean
  sortOrder?: number
  total?: number
}

function enqueueRecordsAutoSync(reason: string) {
  enqueueAutoDataSync('records', reason)
  emitter.emit('plugin-records-changed')
}

export async function getTags(): Promise<Tag[]> {
  // Migrated to kind `tags.list` in wave 4 (W4-CODEMOD). The
  // handler counts non-deleted marks in the tag subtree via the
  // path-prefix rule, matching the upstream totals query.
  const tags = await getSqlAdapter().query({ kind: 'tags.list' })
  return tags.map(tag => ({
    ...tag,
    isLocked: normalizeTagBoolean(tag.isLocked) ?? false,
    isPin: normalizeTagBoolean(tag.isPin) ?? false,
  }))
}

export async function insertTag(tag: Partial<Tag>) {
  // Migrated to kind `tags.create` in wave 4 (W4-CODEMOD). A
  // duplicate name returns the existing tag with affected 0,
  // matching the upstream early return; the result is mapped to
  // the legacy `{rowsAffected, lastInsertId}` shape callers read.
  const name = normalizeTagName(tag.name)
  const result = await getSqlAdapter().execute({ kind: 'tags.create', name })
  if (result.affected === 1) enqueueRecordsAutoSync('tag:insert')
  // The handler always returns the numeric tag id; the kind
  // result type allows string ids for other tables.
  return { rowsAffected: result.affected, lastInsertId: result.id as number }
}

export async function updateTag(tag: Tag) {
  // Migrated to kind `tags.rename` in wave 4 (W4-CODEMOD). The
  // handler carries the full upstream semantics: subtree rename,
  // locked-tag refusal, collision check, and pin/order-only
  // updates when the name is unchanged. The upstream knowledge
  // reindex side effect ran through raw SQL and is dropped; the
  // handler does not reindex either.
  const name = normalizeTagName(tag.name)
  const result = await getSqlAdapter().execute({
    kind: 'tags.rename',
    id: tag.id,
    name,
    ...(tag.isPin === undefined ? {} : { isPin: tag.isPin }),
    ...(tag.sortOrder === undefined ? {} : { sortOrder: tag.sortOrder }),
  })
  enqueueRecordsAutoSync('tag:update')
  return { rowsAffected: result.affected, lastInsertId: result.id as number }
}

export async function delTag(id: number, options: { sync?: boolean } = {}) {
  // Migrated to kind `tags.delete` in wave 4 (W4-CODEMOD). The
  // upstream guards that the kind does not carry are checked
  // locally against `tags.list` first: a missing tag returns
  // `{rowsAffected: 0}`, a locked tag and the last tag throw
  // with the upstream messages. Two upstream refusals are
  // deliberately NOT preserved, per the F4 handler decision: a
  // tag with child tags CAN be deleted, and deleting a tag
  // NEVER marks records deleted: an in-use tag without
  // `reassignTo` throws a CONFLICT instead of trashing records
  // through the old SQLite trigger.
  const tags = (await getTags()).sort((a, b) =>
    Number(b.isLocked ?? false) - Number(a.isLocked ?? false) || a.id - b.id)
  const target = tags.find(tag => tag.id === id)
  if (!target) return { rowsAffected: 0 }
  if (target.isLocked || tags.length < 2) throw new Error('Cannot delete the default or last tag')
  const fallback = tags.find(tag => tag.id !== id)!
  await invalidateLocalTagSyncIdentity([id])
  const result = await getSqlAdapter().execute({ kind: 'tags.delete', id })
  if (result.affected !== 1) throw new Error('Tag could not be deleted; refresh and try again')
  const store = await platform.store.load('store.json')
  if (await store.get<number>('currentTagId') === id) {
    await store.set('currentTagId', fallback.id)
    await store.save()
  }
  if (options.sync !== false) enqueueRecordsAutoSync('tag:delete')
  void import('@/lib/knowledge-index').then(({ reconcileStructuredKnowledgeSources }) => reconcileStructuredKnowledgeSources()).catch(error => console.error('Tag knowledge reconcile failed:', error))
  return { rowsAffected: 1 }
}

export function normalizeTagName(value?: string): string {
  const name = (value || '').trim().replace(/^#/, '').split('/').map(part => part.trim()).join('/')
  if (!name || name.split('/').some(part => !part)) throw new Error('Tag paths must have non-empty segments')
  return name
}

export async function insertTags(tags: Tag[]) {
  // NOT migrated in wave 4: no catalog kind upserts tags by
  // explicit id (restore semantics). `tags.create` assigns
  // server ids and cannot preserve restored ids. Its only
  // caller is the agent tag-restore tool.
  const db = await getDb();
  for (const tag of tags) {
    if (tag.isLocked) continue;
    const exists = await db.select<Tag[]>("select * from tags where id = $1", [tag.id])
    if (exists.length > 0) {
      await db.execute(
        "update tags set name = $1, isLocked = $2, isPin = $3, sortOrder = $4 where id = $5",
        [tag.name, tag.isLocked, tag.isPin, tag.sortOrder, tag.id]
      )
    } else {
      await db.execute(
        "insert into tags (id, name, isLocked, isPin, sortOrder) values ($1, $2, $3, $4, $5)",
        [tag.id, tag.name, tag.isLocked, tag.isPin, tag.sortOrder]
      )
    }
  }
  enqueueRecordsAutoSync('tag:bulk-insert')
  return true;
}

export async function updateTagsOrder(tags: { id: number; sortOrder: number }[]) {
  // Migrated to kind `tags.reorder` in wave 4 (W4-CODEMOD).
  // Unknown ids throw and nothing is applied (all-or-nothing).
  await getSqlAdapter().execute({
    kind: 'tags.reorder',
    order: tags.map(tag => ({ id: tag.id, sortOrder: tag.sortOrder })),
  })
  enqueueRecordsAutoSync('tag:reorder')
  return true;
}

// `initTagsDb` (DDL, Idea seeding, and the trash trigger) and
// `deleteAllTags` (no kind, zero callers) were deleted in wave 4
// (W4-CODEMOD). The table is server-owned (migrations); the
// bootstrap tag is verified, never created, by `initSqlAdapter`.
