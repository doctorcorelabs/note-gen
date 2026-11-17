import { getSqlAdapter } from './index'
import type { SqlActivitySource } from '../lib/platform/sql/ops-catalog'
import { shouldCreateWritingSession, truncateActivityText } from '@/lib/activity/events'

export type ActivityEventSource = 'record' | 'chat' | 'writing' | 'canvas'

export interface ActivityEvent {
  id: number
  source: ActivityEventSource
  title: string
  description?: string | null
  path?: string | null
  tagId?: number | null
  dedupeKey?: string | null
  createdAt: number
}

interface InsertActivityEventInput {
  source: ActivityEventSource
  title: string
  description?: string | null
  path?: string | null
  tagId?: number | null
  dedupeKey?: string | null
  createdAt?: number
}

const ACTIVITY_PAGE_LIMIT = 200

// The `activity.list` cursor is "<createdAtMs>:<id>" over
// createdAt-descending order. Page until a short page.
async function listActivityEvents(source?: SqlActivitySource): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await getSqlAdapter().query({
      kind: 'activity.list',
      ...(source === undefined ? {} : { source }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: ACTIVITY_PAGE_LIMIT,
    })
    events.push(...page)
    if (page.length < ACTIVITY_PAGE_LIMIT) return events
    const last = page[page.length - 1]
    cursor = `${last.createdAt}:${last.id}`
  }
}

// The list has no path filter, so the latest event for one path
// is the first page match in createdAt-descending order. Paging
// stops at the first match.
async function getLatestEventTimestamp(source: SqlActivitySource, path: string): Promise<number | undefined> {
  let cursor: string | undefined
  for (;;) {
    const page = await getSqlAdapter().query({
      kind: 'activity.list',
      source,
      ...(cursor === undefined ? {} : { cursor }),
      limit: ACTIVITY_PAGE_LIMIT,
    })
    const match = page.find((event) => event.path === path)
    if (match !== undefined) return match.createdAt
    if (page.length < ACTIVITY_PAGE_LIMIT) return undefined
    const last = page[page.length - 1]
    cursor = `${last.createdAt}:${last.id}`
  }
}

export async function insertActivityEvent(event: InsertActivityEventInput) {
  // Migrated to kind `activity.insert` in wave 4 (W4-CODEMOD).
  // The handler uses ON CONFLICT DO NOTHING on `dedupeKey`,
  // matching upstream `insert or ignore`; a repeat insert
  // reports affected 0 instead of throwing.
  return await getSqlAdapter().execute({
    kind: 'activity.insert',
    event: {
      source: event.source,
      title: event.title,
      description: event.description ?? null,
      path: event.path ?? null,
      tagId: event.tagId ?? null,
      dedupeKey: event.dedupeKey ?? null,
      createdAt: event.createdAt,
    },
  })
}

export async function getAllActivityEvents(): Promise<ActivityEvent[]> {
  // Migrated to kind `activity.list` in wave 4 (W4-CODEMOD),
  // paged to the end: upstream returned every row.
  return await listActivityEvents()
}

async function getLatestWritingEventTimestamp(path: string) {
  return await getLatestEventTimestamp('writing', path)
}

async function getLatestCanvasEventTimestamp(path: string) {
  return await getLatestEventTimestamp('canvas', path)
}

export async function recordWritingActivity(params: {
  path: string
  title: string
  description?: string
  tagId?: number | null
  createdAt?: number
}) {
  const createdAt = params.createdAt ?? Date.now()
  const lastCreatedAt = await getLatestWritingEventTimestamp(params.path)

  if (!shouldCreateWritingSession(lastCreatedAt, createdAt)) {
    return null
  }

  return await insertActivityEvent({
    source: 'writing',
    title: truncateActivityText(params.title, 64),
    description: truncateActivityText(params.description ?? params.path, 140),
    path: params.path,
    tagId: params.tagId ?? null,
    dedupeKey: `writing:${params.path}:${createdAt}`,
    createdAt,
  })
}

export async function recordCanvasActivity(params: {
  id: string
  title: string
  createdAt?: number
}) {
  const createdAt = params.createdAt ?? Date.now()
  const lastCreatedAt = await getLatestCanvasEventTimestamp(params.id)

  if (!shouldCreateWritingSession(lastCreatedAt, createdAt)) {
    return null
  }

  return await insertActivityEvent({
    source: 'canvas',
    title: truncateActivityText(params.title, 64),
    description: truncateActivityText(params.title, 140),
    path: params.id,
    dedupeKey: `canvas:${params.id}:${createdAt}`,
    createdAt,
  })
}

// `initActivityDb` (DDL plus a backfill over unmigrated readers)
// had zero callers and was deleted in wave 4 (W4-CODEMOD). The
// table is server-owned (migrations). No backfill runs: activity
// history starts empty on the server.
