// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Typed REST client for inbox records and tags (Fase 1, V3-26).
// The inbox has NO endpoint of its own (contract 3.8): every inbox
// operation is a call to /api/marks or /api/tags (contract 3.5-3.6),
// plus POST /api/assets for the image/file create flows (contract
// 3.7). All calls go through the centralized ApiClient (V3-30);
// this module adds no fetch of its own.
//
// Wire rules honored here:
// - Envelope success/error parsing and the canonical error codes
//   come from ApiClient/errors.ts; callers branch on the wire code,
//   never on the message text.
// - Mutations send the CSRF token through the V3-30b seam when one
//   is wired (createWiredRecordsApi), with exactly one refresh and
//   retry on 403 csrf_invalid. Reads report a 401 to the seam and
//   rethrow; a 401 means the session expired (K-10), never a retry.
// - No workspaceId is ever sent; the workspace comes from the
//   session server-side. Echoed workspaceId values in responses
//   are carried through untouched and never used for paths.
// - Multi-select has NO bulk endpoint (contract 3.8, A-10). The
//   sequential helpers below call the per-record endpoint in order
//   and stop at the first error that is not "already gone",
//   reporting what succeeded and what failed. A 404 on
//   delete/restore/permanent counts as success for that item and
//   the loop continues; a 409 on a tag move stops the loop.
// - D-3D-1 RE-VERIFIED (r8f, trunk d8f55765, 17 Nov 2026): the REST
//   /api/marks and /api/tags routes still do not exist; only the kind
//   SqlAdapter handlers exist, over /api/transactions + /api/db/batch.
//   The live UI path in this branch is therefore the kind-backed
//   client, which exposes this same RecordsApi surface over kinds.
//   This REST client is retained unchanged for use after V3-25 lands
//   the REST routes; until then its marks/tags calls answer 404 from
//   the router. Mounting landed in wave 4 (W4-CODEMOD, WebInbox over
//   KindRecordsApi, 17 Nov 2026); live acceptance still waits on a
//   live E2E harness run (E2E-S3).

import {
  ApiClient,
  DEFAULT_API_CLIENT_TIMEOUT_MS,
  defaultApiClient,
} from "./api-client";
import { ApiError } from "./errors";
import {
  createWebApiAuthSeam,
  handleUnauthorizedError,
  withCsrfRetry,
  type WebApiAuthSeam,
} from "./csrf";
import {
  buildListQuery,
  type CreateRecordBody,
  type InboxListFilters,
  type RecordType,
} from "./record-inputs";

export type { CreateRecordBody, RecordType };

/** Wire representation of a record (contract 3.5, V1-14 3.1). */
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
  enrichmentStatus: "none" | string;
  thumbnailUrl: string | null;
  createdAt: number;
  updatedAt: number;
  /** Present and true when a create hit an existing sourceId. */
  duplicate?: boolean;
}

/** Wire representation of a tag (contract 3.6, V1-14 5.1). */
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

export interface RecordListPage {
  items: ApiRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TagList {
  tags: ApiTag[];
}

export interface PermanentDeleteResult {
  id: number;
  deleted: boolean;
  permanent: boolean;
}

export interface EmptyTrashResult {
  purged: number;
  purgedAt: number;
}

export interface DeleteTagResult {
  id: number;
  deleted: boolean;
  reassignedTo: number | null;
}

export interface UploadedAsset {
  assetKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  createdAt: number;
}

export interface PatchRecordBody {
  content?: string;
  desc?: string;
  url?: string;
  /** Optimistic guard (contract 3.5): header If-Match equivalent. */
  expectedVersion?: number;
  force?: boolean;
}

export interface UpdateRecordTagsBody {
  tagIds: number[];
  expectedTagIds?: number[];
  expectedTagVersion?: number;
  force?: boolean;
}

/** One failed item in a sequential multi-select run. */
export interface SequentialFailure {
  id: number;
  code: string | null;
  status: number | null;
  message: string | null;
}

export interface SequentialResult {
  succeeded: number[];
  failed: SequentialFailure[];
  /** True when the loop stopped early on an error (not completed). */
  stoppedEarly: boolean;
}

function errorFacts(error: unknown): {
  code: string | null;
  status: number | null;
  message: string | null;
} {
  if (error instanceof ApiError) {
    return {
      code: error.wireCode ?? error.code,
      status: error.status,
      message: error.wireMessage ?? error.message,
    };
  }
  if (error instanceof Error) {
    return { code: null, status: null, message: error.message };
  }
  return { code: null, status: null, message: null };
}

/** Wire code of an error, for UI branching. Null when not an API error. */
export function apiErrorWireCode(error: unknown): string | null {
  return errorFacts(error).code;
}

export interface RecordsApiOptions {
  client?: ApiClient;
  /** CSRF/401 seam. Absent in tests; present in the wired singleton. */
  seam?: WebApiAuthSeam;
}

/**
 * The inbox data surface shared by the REST client (RecordsApi) and
 * the kind-backed client (KindRecordsApi). UI components and the
 * sequential multi-select helpers depend on this interface, never
 * on one transport, so the live path can change when the REST
 * routes land (D-3D-1) without touching the components. Both
 * implementations throw ApiError with canonical wire codes; callers
 * branch on apiErrorWireCode, never on message text.
 */
export interface RecordsApiPort {
  listRecords(
    filters?: InboxListFilters,
    cursor?: string,
  ): Promise<RecordListPage>;
  listAllRecords(filters?: InboxListFilters): Promise<ApiRecord[]>;
  getRecord(markId: number): Promise<ApiRecord>;
  createRecord(body: CreateRecordBody): Promise<ApiRecord>;
  updateRecord(markId: number, body: PatchRecordBody): Promise<ApiRecord>;
  updateRecordTags(
    markId: number,
    body: UpdateRecordTagsBody,
  ): Promise<ApiRecord>;
  softDeleteRecord(markId: number): Promise<ApiRecord>;
  restoreRecord(markId: number): Promise<ApiRecord>;
  deleteRecordPermanent(markId: number): Promise<PermanentDeleteResult>;
  emptyTrash(): Promise<EmptyTrashResult>;
  listTags(): Promise<TagList>;
  getTag(tagId: number): Promise<ApiTag>;
  createTag(name: string): Promise<ApiTag>;
  updateTag(
    tagId: number,
    body: { name?: string; pinned?: boolean },
  ): Promise<ApiTag>;
  deleteTag(tagId: number, reassignTo?: number): Promise<DeleteTagResult>;
  uploadAsset(file: Blob, fileName?: string): Promise<UploadedAsset>;
}

export class RecordsApi implements RecordsApiPort {
  private readonly client: ApiClient;
  private readonly seam: WebApiAuthSeam | undefined;

  constructor(options: RecordsApiOptions = {}) {
    this.client = options.client ?? defaultApiClient;
    this.seam = options.seam;
  }

  private async read<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    try {
      return await this.client.requestJson<T>(path, {
        query: query as Record<string, string | number | boolean | null | undefined>,
      });
    } catch (error) {
      if (this.seam) handleUnauthorizedError(this.seam, error, { path });
      throw error;
    }
  }

  private async mutate<T>(
    path: string,
    options: {
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      jsonBody?: unknown;
      formDataBody?: FormData;
      idempotencyKey?: string;
    },
  ): Promise<T> {
    const attempt = () =>
      this.client.requestJson<T>(path, {
        method: options.method,
        jsonBody: options.jsonBody,
        formDataBody: options.formDataBody,
        idempotencyKey: options.idempotencyKey,
      });
    if (!this.seam) return attempt();
    // The attempt reads the refreshed token through the client's
    // provider on retry; the token argument itself is unused here
    // because ApiClient owns header attachment.
    return withCsrfRetry(this.seam, () => attempt(), { path });
  }

  // -- Records: list and read -------------------------------------------

  /** Inbox list page. Filters follow buildListQuery (A-12 rules). */
  listRecords(
    filters: InboxListFilters = {},
    cursor?: string,
  ): Promise<RecordListPage> {
    return this.read<RecordListPage>(
      "/api/marks",
      buildListQuery(filters, cursor),
    );
  }

  /** All pages of a list, in order. Stops when hasMore is false. */
  async listAllRecords(
    filters: InboxListFilters = {},
  ): Promise<ApiRecord[]> {
    const items: ApiRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listRecords(filters, cursor);
      items.push(...page.items);
      if (!page.hasMore || !page.nextCursor) return items;
      cursor = page.nextCursor;
    }
  }

  getRecord(markId: number): Promise<ApiRecord> {
    return this.read<ApiRecord>(`/api/marks/${markId}`);
  }

  // -- Records: create and edit ------------------------------------------

  /**
   * Create one record. The caller supplies sourceId in the body
   * (built once per user action); a duplicate answers with the
   * existing record and duplicate: true, without a second row.
   */
  createRecord(body: CreateRecordBody): Promise<ApiRecord> {
    return this.mutate<ApiRecord>("/api/marks", {
      method: "POST",
      jsonBody: body,
      idempotencyKey: body.sourceId ?? undefined,
    });
  }

  /**
   * Edit content/desc/url with the optimistic guard. The UI always
   * sends expectedVersion from the record it read; a stale guard
   * answers 409 revision_conflict and nothing is overwritten.
   */
  updateRecord(
    markId: number,
    body: PatchRecordBody,
  ): Promise<ApiRecord> {
    return this.mutate<ApiRecord>(`/api/marks/${markId}`, {
      method: "PATCH",
      jsonBody: body,
    });
  }

  /**
   * Replace the record's tag set. expectedTagIds is required
   * unless force is true; a changed set answers 409
   * record_tags_changed with the current tag ids in details.
   */
  updateRecordTags(
    markId: number,
    body: UpdateRecordTagsBody,
  ): Promise<ApiRecord> {
    return this.mutate<ApiRecord>(`/api/marks/${markId}/tags`, {
      method: "PUT",
      jsonBody: body,
    });
  }

  // -- Records: delete, restore, trash ------------------------------------

  softDeleteRecord(markId: number): Promise<ApiRecord> {
    return this.mutate<ApiRecord>(`/api/marks/${markId}`, {
      method: "DELETE",
    });
  }

  restoreRecord(markId: number): Promise<ApiRecord> {
    return this.mutate<ApiRecord>(`/api/marks/${markId}/restore`, {
      method: "POST",
      jsonBody: {},
    });
  }

  deleteRecordPermanent(markId: number): Promise<PermanentDeleteResult> {
    return this.mutate<PermanentDeleteResult>(
      `/api/marks/${markId}/permanent`,
      { method: "DELETE" },
    );
  }

  /**
   * Empty the trash (contract 3.5, AD-32). The UI must confirm
   * explicitly before calling; the body confirm flag is mandatory.
   */
  emptyTrash(): Promise<EmptyTrashResult> {
    return this.mutate<EmptyTrashResult>("/api/marks/trash", {
      method: "DELETE",
      jsonBody: { confirm: true },
    });
  }

  // -- Tags ----------------------------------------------------------------

  listTags(): Promise<TagList> {
    return this.read<TagList>("/api/tags");
  }

  getTag(tagId: number): Promise<ApiTag> {
    return this.read<ApiTag>(`/api/tags/${tagId}`);
  }

  createTag(name: string): Promise<ApiTag> {
    return this.mutate<ApiTag>("/api/tags", {
      method: "POST",
      jsonBody: { name },
    });
  }

  updateTag(
    tagId: number,
    body: { name?: string; pinned?: boolean },
  ): Promise<ApiTag> {
    return this.mutate<ApiTag>(`/api/tags/${tagId}`, {
      method: "PATCH",
      jsonBody: body,
    });
  }

  /**
   * Delete a tag. When the tag is still in use the caller passes
   * reassignTo; without it the server answers 409 tag_in_use.
   * Deleting a tag never trashes records (D-03).
   */
  deleteTag(tagId: number, reassignTo?: number): Promise<DeleteTagResult> {
    const path =
      reassignTo === undefined
        ? `/api/tags/${tagId}`
        : `/api/tags/${tagId}?reassignTo=${reassignTo}`;
    return this.mutate<DeleteTagResult>(path, { method: "DELETE" });
  }

  // -- Record assets (create flows only) ------------------------------------

  /**
   * Upload one file for an image/file record (contract 3.7). One
   * request uploads one file: one `file` part plus an optional
   * `fileName` part. The returned assetKey becomes the record url.
   * Asset listing and deletion UI belong to V3-32, not here.
   */
  uploadAsset(file: Blob, fileName?: string): Promise<UploadedAsset> {
    const form = new FormData();
    form.append("file", file, fileName ?? "upload");
    if (fileName !== undefined) form.append("fileName", fileName);
    return this.mutate<UploadedAsset>("/api/assets", {
      method: "POST",
      formDataBody: form,
    });
  }
}

// ---------------------------------------------------------------------------
// Sequential multi-select (no bulk endpoint)
// ---------------------------------------------------------------------------

async function runSequential(
  ids: number[],
  runOne: (id: number) => Promise<unknown>,
  treatNotFoundAsSuccess: boolean,
): Promise<SequentialResult> {
  const succeeded: number[] = [];
  const failed: SequentialFailure[] = [];
  for (const id of ids) {
    try {
      await runOne(id);
      succeeded.push(id);
    } catch (error) {
      const facts = errorFacts(error);
      if (
        treatNotFoundAsSuccess &&
        facts.status === 404 &&
        facts.code === "not_found"
      ) {
        succeeded.push(id);
        continue;
      }
      failed.push({ id, ...facts });
      return { succeeded, failed, stoppedEarly: true };
    }
  }
  return { succeeded, failed, stoppedEarly: false };
}

/**
 * Move several records to a new tag set, one call per record, in
 * order. Each item carries its own expectedTagIds. Stops at the
 * first 409 (or any error) and reports what changed and what did
 * not; the caller reloads the changed records and shows the
 * failure, never continuing silently.
 */
export function moveRecordsTagsSequential(
  api: RecordsApiPort,
  items: Array<{ id: number; tagIds: number[]; expectedTagIds: number[] }>,
): Promise<SequentialResult> {
  return runSequential(
    items.map((item) => item.id),
    (id) => {
      const item = items.find((entry) => entry.id === id)!;
      return api.updateRecordTags(id, {
        tagIds: item.tagIds,
        expectedTagIds: item.expectedTagIds,
      });
    },
    false,
  );
}

/** Soft delete several records, in order, stop-and-report. */
export function softDeleteRecordsSequential(
  api: RecordsApiPort,
  ids: number[],
): Promise<SequentialResult> {
  return runSequential(ids, (id) => api.softDeleteRecord(id), true);
}

/** Restore several records, in order, stop-and-report. */
export function restoreRecordsSequential(
  api: RecordsApiPort,
  ids: number[],
): Promise<SequentialResult> {
  return runSequential(ids, (id) => api.restoreRecord(id), true);
}

/** Permanently delete several records, in order, stop-and-report. */
export function deleteRecordsPermanentSequential(
  api: RecordsApiPort,
  ids: number[],
): Promise<SequentialResult> {
  return runSequential(ids, (id) => api.deleteRecordPermanent(id), true);
}

// ---------------------------------------------------------------------------
// Wired singleton
// ---------------------------------------------------------------------------

export interface WiredRecordsApi {
  api: RecordsApi;
  seam: WebApiAuthSeam;
  client: ApiClient;
}

/**
 * Build a RecordsApi whose mutations carry the CSRF token from the
 * shared seam store, with one refresh-and-retry on csrf_invalid
 * and session-expiry notification on 401. This is the production
 * wiring until a shared app-level client lands; the seam instance
 * is owned here and must not be duplicated per component.
 */
export function createWiredRecordsApi(): WiredRecordsApi {
  const seam = createWebApiAuthSeam();
  const client = new ApiClient({
    csrfTokenProvider: () => seam.csrf.getToken(),
    onUnauthorized: (error) => {
      handleUnauthorizedError(seam, error);
    },
    defaultTimeoutMs: DEFAULT_API_CLIENT_TIMEOUT_MS,
  });
  return { api: new RecordsApi({ client, seam }), seam, client };
}

export const recordsApi: RecordsApi = createWiredRecordsApi().api;
