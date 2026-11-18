// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace export assembly (R24-DEC2E, AD-201 item 2A: one minimal
// export endpoint that actually runs). This module builds the export
// document from the workspace reader only: it performs no filesystem
// access of its own, so path validation, symlink rejection, hidden
// path handling, and text decoding all come from the proven read
// service (services/workspace/read.ts). Hidden files are never
// exported, matching the read API.
//
// The document is a plaintext JSON copy of the workspace text files.
// It is NOT the encrypted notegen-web-backup v1 archive of kontrak
// 3.10 / V1-17: no encryption, no async job, no download token, no
// staging, and no restore reader. Those remain Fase 2 work. The
// format name below ("notegen-web-export") is deliberately distinct
// from the backup archive format so the two can never be confused.
//
// Honesty rules for the document:
// - Every file the walk meets appears exactly once: either with its
//   content, or in the omitted list with a catalog reason
//   (not_text_file, invalid_text_encoding, not_found). A file that
//   disappears mid-walk is omitted, never silently dropped, and a
//   binary file never fails the whole export.
// - Any other failure fails the whole export with no partial body:
//   the route sends the document only after assembly completes.
// - There is no consistency snapshot. Files are read one by one, so
//   a workspace edited during export can yield a document that mixes
//   revisions. The exportedAt stamp records when assembly started.
// - Size caps fail closed with the catalog code payload_too_large.
//   No new error code is introduced: kontrak section 6 forbids codes
//   outside the catalog without a contract amendment.

import { createHash } from 'node:crypto';
import { ApiError } from '../../plugins/envelope.js';
import {
  createWorkspaceReader,
  type ListResult,
  type PaginationQuery,
  type ReadFileResult,
} from './read.js';

// AD-201 minimal bounds. A workspace beyond either bound is refused
// with 413 rather than truncated: a silent partial export would look
// like a complete copy of the data.
export const MAX_EXPORT_FILES = 1000;
export const MAX_EXPORT_DIRECTORIES = 1000;
export const MAX_EXPORT_TOTAL_BYTES = 10 * 1024 * 1024;

export const EXPORT_FORMAT = 'notegen-web-export';
export const EXPORT_VERSION = 1;

export interface WorkspaceExportFile {
  path: string;
  size: number;
  sha256: string;
  content: string;
}

export type WorkspaceExportOmissionReason =
  | 'not_text_file'
  | 'invalid_text_encoding'
  | 'not_found';

export interface WorkspaceExportOmitted {
  path: string;
  size: number | null;
  reason: WorkspaceExportOmissionReason;
}

export interface WorkspaceExportDocument {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  fileCount: number;
  omittedCount: number;
  totalBytes: number;
  files: WorkspaceExportFile[];
  omitted: WorkspaceExportOmitted[];
}

// Minimal reader surface the assembly needs. The real workspace
// reader satisfies this shape; specs substitute a fake reader.
export interface WorkspaceExportReader {
  list(pathInput: unknown, query: PaginationQuery): Promise<ListResult>;
  readFile(
    pathInput: unknown,
    ifNoneMatch: string | string[] | undefined,
  ): Promise<ReadFileResult>;
}

export interface WorkspaceExportOptions {
  exportedAt?: string;
  maxFiles?: number;
  maxDirectories?: number;
  maxTotalBytes?: number;
}

export interface WorkspaceExporterDeps {
  workspaceRoot: string | undefined;
}

function comparePaths(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function tooLarge(): ApiError {
  return ApiError.payloadTooLarge('The workspace export is too large for a single download.');
}

function omissionReason(error: ApiError): WorkspaceExportOmissionReason | null {
  if (
    error.code === 'not_text_file' ||
    error.code === 'invalid_text_encoding' ||
    error.code === 'not_found'
  ) {
    return error.code;
  }
  return null;
}

export async function buildWorkspaceExport(
  reader: WorkspaceExportReader,
  options: WorkspaceExportOptions = {},
): Promise<WorkspaceExportDocument> {
  const maxFiles = options.maxFiles ?? MAX_EXPORT_FILES;
  const maxDirectories = options.maxDirectories ?? MAX_EXPORT_DIRECTORIES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_EXPORT_TOTAL_BYTES;
  const exportedAt = options.exportedAt ?? new Date().toISOString();

  const files: WorkspaceExportFile[] = [];
  const omitted: WorkspaceExportOmitted[] = [];
  let totalBytes = 0;
  let consideredFiles = 0;
  let visitedDirectories = 0;

  // Depth-first walk from the root. The reader sorts each directory
  // listing; the final document is sorted by path regardless, so the
  // output order does not depend on traversal order.
  const stack: string[] = [''];
  while (stack.length > 0) {
    const folder = stack.pop() as string;
    visitedDirectories += 1;
    if (visitedDirectories > maxDirectories) {
      throw tooLarge();
    }
    let cursor: string | undefined;
    for (;;) {
      const page = await reader.list(folder, {
        cursor,
        limit: '1000',
        includeMetadata: 'true',
      });
      for (const entry of page.entries) {
        if (entry.isDirectory) {
          stack.push(entry.path);
          continue;
        }
        if (!entry.isFile) {
          continue;
        }
        consideredFiles += 1;
        if (consideredFiles > maxFiles) {
          throw tooLarge();
        }
        let result: ReadFileResult;
        try {
          result = await reader.readFile(entry.path, undefined);
        } catch (error) {
          if (error instanceof ApiError) {
            const reason = omissionReason(error);
            if (reason !== null) {
              omitted.push({ path: entry.path, size: entry.size, reason });
              continue;
            }
          }
          throw error;
        }
        if (result.text === null) {
          omitted.push({ path: entry.path, size: entry.size, reason: 'not_found' });
          continue;
        }
        const contentBytes = Buffer.from(result.text, 'utf8');
        totalBytes += contentBytes.length;
        if (totalBytes > maxTotalBytes) {
          throw tooLarge();
        }
        files.push({
          path: entry.path,
          size: result.size,
          sha256: createHash('sha256').update(contentBytes).digest('hex'),
          content: result.text,
        });
      }
      if (!page.hasMore || page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }
  }

  files.sort((a, b) => comparePaths(a.path, b.path));
  omitted.sort((a, b) => comparePaths(a.path, b.path));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt,
    fileCount: files.length,
    omittedCount: omitted.length,
    totalBytes,
    files,
    omitted,
  };
}

export function createWorkspaceExporter(deps: WorkspaceExporterDeps): {
  exportWorkspace: () => Promise<WorkspaceExportDocument>;
} {
  const reader = createWorkspaceReader({ workspaceRoot: deps.workspaceRoot });
  return {
    exportWorkspace: () => buildWorkspaceExport(reader),
  };
}
