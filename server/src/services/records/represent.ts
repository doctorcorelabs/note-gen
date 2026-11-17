// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Wire representations for the REST marks/tags routes (kontrak
// 3.5/3.6, V1-14 3.1/5.1). The shapes mirror the client types in
// src/lib/web/records-client.ts exactly; the server must never
// drift from them silently, so the field lists here are
// exhaustive by construction.
//
// Schema gaps, stated plainly (W4-WIRE, MVP):
// - fileName is always null: no file_name column exists.
// - enrichmentStatus is always "none" (V1-14: the only MVP value).
// - thumbnailUrl is always null: no thumbnail generation exists.
// - tagVersion ALIASES version: no tag_version column exists.
//   Every tag change bumps version, so comparing
//   expectedTagVersion against version never misses a tag
//   change; it may also trip on a content edit, which is the
//   conservative direction for an optimistic guard. Adding a
//   tag_version column is a migration, out of wiring scope.
// - tagIds is sorted ascending with the primary tag conveyed
//   separately by tagId, matching the kind transport's
//   effectiveTagIds order. mark_tags has no position column, so
//   the "order preserved" wording of V1-14 3.6 cannot round-trip
//   non-primary order; clients must treat tagIds as a set with a
//   distinguished primary.

import type { RecordType } from './validation.js';

export interface MarkRow {
  id: number;
  workspaceId: string;
  type: RecordType;
  content: string;
  desc: string;
  url: string;
  tagId: number;
  tagIds: number[];
  version: number;
  deletedAt: number | null;
  sourceId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TagRow {
  id: number;
  workspaceId: string;
  name: string;
  locked: boolean;
  pinned: boolean;
  recordCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ApiRecord {
  id: number;
  workspaceId?: string;
  type: RecordType;
  content: string;
  desc: string;
  url: string;
  fileName: string | null;
  tagId: number;
  tagIds: number[];
  tagVersion: number;
  version: number;
  deleted: boolean;
  deletedAt: number | null;
  sourceId: string | null;
  enrichmentStatus: 'none' | string;
  thumbnailUrl: string | null;
  createdAt: number;
  updatedAt: number;
  duplicate?: boolean;
}

export interface ApiTag {
  id: number;
  workspaceId?: string;
  name: string;
  locked: boolean;
  pinned: boolean;
  recordCount: number;
  createdAt: number;
  updatedAt: number;
}

export function sortedTagIds(primaryTagId: number, extraIds: readonly number[]): number[] {
  return [...new Set([primaryTagId, ...extraIds])].sort((a, b) => a - b);
}

export function toApiRecord(row: MarkRow, duplicate = false): ApiRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    content: row.content,
    desc: row.desc,
    url: row.url,
    fileName: null,
    tagId: row.tagId,
    tagIds: [...row.tagIds],
    tagVersion: row.version,
    version: row.version,
    deleted: row.deletedAt !== null,
    deletedAt: row.deletedAt,
    sourceId: row.sourceId,
    enrichmentStatus: 'none',
    thumbnailUrl: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(duplicate ? { duplicate: true } : {}),
  };
}

export function toApiTag(row: TagRow): ApiTag {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    locked: row.locked,
    pinned: row.pinned,
    recordCount: row.recordCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
