// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Direct keyword search port (W4-WIRE, production): loads real
// candidates and runs the shared engine from port.ts. Records
// come from the marks tables, files come from a tree walk over
// the workspace root. There is no search index in MVP: every
// request scans the workspace's active records and Markdown
// files. That is the honest interim shape until the V3-06
// index-backed port lands; the loader is the only part an
// index replaces, because the engine and the routes are
// index-agnostic.
//
// Scoping and failure behavior:
// - Records scope (and scope "all") requires a database handle:
//   without one the port answers 503, because partial results
//   that silently omit every record would mislead. A principal
//   with no accessible workspace answers the generic 404
//   (AD-08). Trash (deletedAt set) is never loaded.
// - Files scope requires a workspace root: without one it
//   answers 503. File versions come from the files index when a
//   database handle and a resolvable workspace are available;
//   otherwise versions are 0 ("unknown"). A failed version
//   lookup never fails a files search: the content comes from
//   disk, and versions are auxiliary guard metadata.
// - The walk follows the reconcile scanner's rules: dot-leading
//   names and symlinks are skipped, only `.md` files are read
//   (case-sensitive, matching the read service), and a file that
//   cannot be read is skipped rather than failing the search.
// - Todo records match over their parsed title + description,
//   not over the raw JSON envelope (S-05 convention); a todo
//   whose content is not JSON matches over the raw content, the
//   same legacy tolerance the read path applies. The extraction
//   happens in the loader, so the shared engine and the fake
//   keep their exact behavior.

import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { files, markTags, marks, type Database } from '../../db/index.js';
import { contentHash } from '../../lib/revision.js';
import type { SessionPrincipal } from '../../middleware/auth-hook.js';
import { ApiError } from '../../plugins/envelope.js';
import {
  executeKeywordSearch,
  type FakeSearchItem,
  type KeywordSearchInput,
  type KeywordSearchPort,
  type SearchPage,
} from './port.js';

export type DirectSearchWorkspaceResolver = (principal: SessionPrincipal) => Promise<string | null>;

export interface DirectKeywordSearchPortDeps {
  db?: Database;
  workspaceRoot: string | undefined;
  resolveWorkspaceId: DirectSearchWorkspaceResolver;
}

function searchableContent(type: string, content: string): string {
  if (type !== 'todo') {
    return content;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const title = typeof record['title'] === 'string' ? record['title'] : '';
      const description = typeof record['description'] === 'string' ? record['description'] : '';
      const combined = `${title} ${description}`.trim();
      return combined === '' ? content : combined;
    }
  } catch {
    // Legacy non-JSON todo content: match the raw text.
  }
  return content;
}

async function loadRecordItems(db: Database, workspaceId: string): Promise<FakeSearchItem[]> {
  let rows;
  let tagRows;
  try {
    rows = await db
      .select({
        id: marks.id,
        tagId: marks.tagId,
        type: marks.type,
        content: marks.content,
        url: marks.url,
        desc: marks.desc,
        createdAt: marks.createdAt,
        updatedAt: marks.updatedAt,
      })
      .from(marks)
      .where(and(eq(marks.workspaceId, workspaceId), isNull(marks.deletedAt)));
    tagRows = await db
      .select({ markId: markTags.markId, tagId: markTags.tagId })
      .from(markTags)
      .where(eq(markTags.workspaceId, workspaceId));
  } catch {
    throw ApiError.serviceUnavailable('The database is not available.');
  }
  const tagsByMark = new Map<number, number[]>();
  for (const row of tagRows) {
    const list = tagsByMark.get(row.markId) ?? [];
    list.push(row.tagId);
    tagsByMark.set(row.markId, list);
  }
  return rows.map((row) => {
    const content = row.content ?? '';
    const tagIds = [row.tagId, ...(tagsByMark.get(row.id) ?? [])].filter(
      (tagId, index, all) => all.indexOf(tagId) === index,
    );
    return {
      kind: 'record',
      id: row.id,
      title: row.desc ?? '',
      content: searchableContent(row.type, content),
      fileName: '',
      type: row.type,
      tagIds,
      url: row.url ?? '',
      updatedAt: row.updatedAt.getTime(),
      createdAt: row.createdAt.getTime(),
    } satisfies FakeSearchItem;
  });
}

async function loadVersionMap(db: Database, workspaceId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ path: files.path, version: files.version })
    .from(files)
    .where(and(eq(files.workspaceId, workspaceId), isNull(files.deletedAt)));
  const versions = new Map<string, number>();
  for (const row of rows) {
    versions.set(row.path, row.version);
  }
  return versions;
}

async function loadFileItems(
  workspaceRoot: string,
  versions: ReadonlyMap<string, number>,
): Promise<{ items: FakeSearchItem[]; skipped: number }> {
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
    const rootStats = await stat(rootReal);
    if (!rootStats.isDirectory()) {
      throw ApiError.serviceUnavailable('The workspace is not available.');
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw ApiError.serviceUnavailable('The workspace is not available.');
  }
  const items: FakeSearchItem[] = [];
  // DA-2 (F-15-03): count only error-driven skips (readdir,
  // lstat, readFile failures). Rule-based skips below (dot
  // segments, symlinks, non-.md) are not degradation.
  let skipped = 0;
  const stack: string[] = [''];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const currentFs = current === '' ? rootReal : join(rootReal, ...current.split('/'));
    let dirents;
    try {
      dirents = await readdir(currentFs, { withFileTypes: true });
    } catch {
      skipped += 1;
      continue;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) {
        continue;
      }
      const childPath = current === '' ? dirent.name : `${current}/${dirent.name}`;
      const childFs = join(currentFs, dirent.name);
      let childStats;
      try {
        childStats = await lstat(childFs);
      } catch {
        skipped += 1;
        continue;
      }
      if (childStats.isSymbolicLink()) {
        continue;
      }
      if (childStats.isDirectory()) {
        stack.push(childPath);
        continue;
      }
      if (!childStats.isFile() || !childPath.endsWith('.md')) {
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(childFs);
      } catch {
        skipped += 1;
        continue;
      }
      items.push({
        kind: 'file',
        path: childPath,
        content: bytes.toString('utf8'),
        contentHash: contentHash(bytes),
        version: versions.get(childPath) ?? 0,
        updatedAt: Math.floor(childStats.mtimeMs),
      });
    }
  }
  return { items, skipped };
}

export function createDirectKeywordSearchPort(
  deps: DirectKeywordSearchPortDeps,
): KeywordSearchPort {
  return {
    async search(input: KeywordSearchInput): Promise<SearchPage> {
      const needsRecords = input.scope !== 'files';
      const needsFiles = input.scope !== 'records';
      let workspaceId: string | null = null;
      if (needsRecords) {
        if (deps.db === undefined) {
          throw ApiError.serviceUnavailable('The database is not available.');
        }
        workspaceId = await deps.resolveWorkspaceId(input.principal);
        if (workspaceId === null) {
          throw ApiError.notFound();
        }
      }
      const items: FakeSearchItem[] = [];
      let degraded = false;
      if (needsRecords && deps.db !== undefined && workspaceId !== null) {
        items.push(...(await loadRecordItems(deps.db, workspaceId)));
      }
      if (needsFiles) {
        if (deps.workspaceRoot === undefined) {
          throw ApiError.serviceUnavailable('The workspace is not available.');
        }
        let versions: ReadonlyMap<string, number> = new Map();
        if (deps.db !== undefined) {
          if (workspaceId === null) {
            try {
              workspaceId = await deps.resolveWorkspaceId(input.principal);
            } catch {
              workspaceId = null;
              degraded = true;
            }
          }
          if (workspaceId !== null) {
            try {
              versions = await loadVersionMap(deps.db, workspaceId);
            } catch {
              versions = new Map();
              degraded = true;
            }
          }
        }
        const loaded = await loadFileItems(deps.workspaceRoot, versions);
        items.push(...loaded.items);
        if (loaded.skipped > 0) degraded = true;
      }
      return { ...executeKeywordSearch(items, input), degraded };
    },
  };
}
