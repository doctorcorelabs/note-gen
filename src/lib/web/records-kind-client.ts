// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Kind-backed inbox records client (Fase 1, V3-26, D-3D-1).
//
// D-3D-1 RE-VERIFIED (r8f, trunk d8f55765, 17 Nov 2026): the REST
// routes for marks and tags do not exist in the tree. The only live
// data path is the kind SqlAdapter over the transactions and batch
// endpoints (contract 3.4). This module is the live UI path: it
// implements the same RecordsApiPort surface as the REST client
// (records-client.ts) over SqlAdapter kinds, so the inbox
// components run unchanged against the path that exists today. The
// REST client is retained for use after V3-25 lands the REST
// routes; nothing here invents an endpoint.
//
// Construction: the caller injects a SqlAdapter-shaped object
// (KindSqlAdapter) and an asset uploader. This module never imports
// an adapter implementation (*.web) and never touches the platform
// registry: the sql adapter is registered by registerWebAdapters
// (wiring.ts), and the mounted inbox (WebInbox, wave 4) reads
// platform.sql and passes it here. Asset upload stays on the REST
// assets route, which exists (contract 3.7); the injected uploader
// is normally the REST RecordsApi instance.
//
// Kind mapping (contract 3.5/3.6 operations over kinds):
// - list: marks.list, or marks.listByTag for one tag.
// - read: marks.get (returns deleted rows too; empty means missing).
// - create: marks.create, then marks.get; affected 0 means the
//   sourceId already existed (first-write-wins, duplicate: true).
// - edit: marks.update with expected version, then marks.get.
// - tags: marks.updateTags with the set guard, then marks.get.
// - soft delete / restore / permanent: marks.softDelete,
//   marks.restore, marks.deletePermanent.
// - tags list/read/create/rename: tags.list, tags.get,
//   tags.create, tags.rename.
// - tag delete: tags.delete, with reassignTo when the caller
//   supplies one (D-03: refusing an in-use tag without reassignTo
//   is the server's answer, surfaced as 409 tag_in_use). Emptying
//   the trash has no kind at all and throws
//   capability_unavailable locally, honestly, instead of calling a
//   path that cannot answer. When the REST route lands, the
//   integrator switches empty-trash; do not emulate it with
//   per-record calls: the contract defines it as one transaction
//   with an activity event, which client-side looping cannot
//   reproduce.
//
// Divergences from the REST contract, all deliberate and recorded
// here (integrator escalation D-3D-1):
// 1. List filters: kinds support only one tag, the deleted filter,
//    cursor, and limit, in created-descending order. The text
//    filter, type filter, created range, tag rules, multi-tag
//    filter, and other sort orders are REJECTED with a plain
//    error, never faked with page-local filtering. The default
//    inbox view (one tag or all, active/trash/all) works fully.
// 2. Row shape: kind rows carry no file name, no tag version
//    counter, no deletion timestamp, no enrichment status, and no
//    thumbnail. The adapter fills fileName null, tagVersion 0
//    (unknown, never a guard input), deletedAt null,
//    enrichmentStatus "none" (the MVP value), and thumbnailUrl
//    null. Tag rows carry no timestamps: createdAt/updatedAt are
//    0 (unknown). The UI must not display tag timestamps.
// 3. Tag totals: tags.list fills record counts; tags.get does not,
//    so getTag and updateTag report recordCount 0. Lists reload
//    from listTags, which carries real counts.
// 4. Create without tags: REST resolves the default save target
//    server-side. Kinds require a primary tag, so the adapter
//    reads tags.list and uses the locked tag; with no locked tag
//    it fails honestly instead of guessing a tag.
// 5. Tag rename on a locked tag: the kind allows pin-only changes
//    on locked tags, but the contract forbids changing pin on a
//    locked tag (except re-sending the same value). The adapter
//    enforces the contract rule from a fresh read before calling
//    the kind.
// 6. Tag create duplicates: the kind returns the existing tag with
//    affected 0; the adapter converts that to 409 tag_name_taken,
//    matching the REST route, which distinguishes the same way.
// 7. Unknown tag ids in updateTags are ignored by the kind (400
//    only when none is valid); REST answers tag_not_found. The
//    adapter does not pre-validate ids: UI ids come from the
//    server tag list, and an extra list read per tag edit would
//    still race the write.
// 8. Asset existence: the kind accepts any url string, so the
//    asset_not_found check for image/file records is unavailable
//    here; REST enforces it. The adapter enforces the per-type url
//    shape rules and the todo JSON rules client-side instead,
//    because the kind enforces neither.
// 9. Restore does not prune missing tags or fall back to a default
//    tag; that is REST route work. The kind restores the row with
//    its stored tag set.
// 10. Guard conversion: expectedTagVersion has no kind equivalent.
//     When only a version is supplied, the adapter reads the
//     current tag set and guards on that set; a concurrent change
//     between the read and the write still answers 409 from the
//     server set comparison. The version value itself is never
//     sent. Force writes omit the guard, as in REST; the kind
//     path cannot record the force-overwrite audit the REST
//     service writes.
// 11. Errors: SqlAdapter failures are translated structurally to
//     ApiError with the exact wire code, status, requestId, and
//     details, so UI branching on apiErrorWireCode works
//     identically on both transports. The adapter error class is
//     never imported (it lives in a *.web implementation file);
//     recognition is structural, following the port-error pattern
//     in the SQL adapter itself.
//
// No bulk endpoint is used or assumed: the sequential helpers in
// records-client.ts accept this class through RecordsApiPort and
// keep their per-record stop-and-report behavior. No enrichment
// job and no clipper is called from this module.

import type {
  SqlDeletedFilter,
  SqlMarkPatch,
  SqlMarkRow,
  SqlReadOpKind,
  SqlReadOperationByKind,
  SqlReadRow,
  SqlTagRow,
  SqlWriteOpKind,
  SqlWriteOperationByKind,
  SqlWriteResultFor,
} from "../platform/sql/ops-catalog";
import {
  ApiError,
  deriveRetryable,
  mapStatusToLocalCode,
  mapWireCodeToLocalCode,
} from "./errors";
import type {
  CreateRecordBody,
  InboxListFilters,
  RecordType,
} from "./record-inputs";
import type {
  ApiRecord,
  ApiTag,
  DeleteTagResult,
  EmptyTrashResult,
  PatchRecordBody,
  PermanentDeleteResult,
  RecordListPage,
  RecordsApiPort,
  TagList,
  UpdateRecordTagsBody,
  UploadedAsset,
} from "./records-client";

/**
 * The narrow SqlAdapter surface this client needs. WebSqlAdapter
 * satisfies it structurally (query, queryOne, execute); tests pass
 * a fake. Nothing here depends on the adapter class, its port, or
 * the registry.
 */
export interface KindSqlAdapter {
  query<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K>[]>;
  queryOne<K extends SqlReadOpKind>(
    op: SqlReadOperationByKind<K>,
  ): Promise<SqlReadRow<K> | null>;
  execute<K extends SqlWriteOpKind>(
    op: SqlWriteOperationByKind<K>,
  ): Promise<SqlWriteResultFor<K>>;
}

/** Asset upload seam: normally the REST RecordsApi instance. */
export interface KindAssetUploader {
  uploadAsset(file: Blob, fileName?: string): Promise<UploadedAsset>;
}

export interface KindRecordsApiOptions {
  sql: KindSqlAdapter;
  assets: KindAssetUploader;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Translate an adapter or port failure to ApiError, preserving the
 * wire code. Recognition is structural: the SqlAdapterError and
 * SqlDbClientError classes live in platform implementation files
 * this module must not import. Anything that does not look like an
 * adapter failure (local validation errors, programming errors)
 * is rethrown unchanged, never disguised as a wire error.
 */
export function translateKindError(error: unknown): unknown {
  if (error instanceof ApiError) {
    return error;
  }
  if (!(error instanceof Error)) {
    return error;
  }
  const shape = error as Error & Record<string, unknown>;
  const details = isRecordValue(shape.details) ? shape.details : null;
  const detailsWireCode = details === null ? null : asString(details.wireCode);
  const flatCode = asString(shape.code);
  const name = error.name;
  const looksLikeAdapterError =
    name === "SqlAdapterError" ||
    name === "SqlDbClientError" ||
    detailsWireCode !== null ||
    (flatCode !== null && asNumber(shape.status) !== null);
  if (!looksLikeAdapterError) {
    return error;
  }
  const wireCode = detailsWireCode ?? flatCode;
  const status =
    (details === null ? null : asNumber(details.status)) ??
    asNumber(shape.status);
  const requestId =
    (details === null ? null : asString(details.requestId)) ??
    asString(shape.requestId);
  const retryable =
    typeof shape.retryable === "boolean"
      ? shape.retryable
      : deriveRetryable(wireCode, status);
  const localCode =
    wireCode !== null
      ? mapWireCodeToLocalCode(wireCode, status ?? undefined)
      : status !== null
        ? mapStatusToLocalCode(status)
        : "SERVER_ERROR";
  return new ApiError({
    localCode,
    wireCode,
    status,
    retryable,
    requestId,
    details: details === null ? {} : { ...details },
  });
}

function notFoundError(): ApiError {
  return new ApiError({
    localCode: mapWireCodeToLocalCode("not_found", 404),
    wireCode: "not_found",
    status: 404,
    retryable: false,
    details: {},
  });
}

function toApiRecord(row: SqlMarkRow, duplicate?: boolean): ApiRecord {
  return {
    id: row.id,
    type: row.type,
    content: row.content ?? "",
    desc: row.desc ?? "",
    url: row.url,
    fileName: null,
    tagId: row.tagId,
    tagIds: [...row.tagIds],
    // Kind rows carry tagUpdatedAt, not a version counter. Zero
    // marks unknown; tag guards use id sets, never this value.
    tagVersion: 0,
    version: row.version,
    deleted: row.deleted,
    deletedAt: null,
    sourceId: row.sourceId ?? null,
    enrichmentStatus: "none",
    thumbnailUrl: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(duplicate === true ? { duplicate: true } : {}),
  };
}

function toApiTag(row: SqlTagRow): ApiTag {
  return {
    id: row.id,
    name: row.name,
    locked: row.isLocked,
    pinned: row.isPin,
    recordCount: row.total ?? 0,
    // Kind tag rows carry no timestamps. Zero marks unknown; the
    // UI must not display tag timestamps.
    createdAt: 0,
    updatedAt: 0,
  };
}

function compareTagNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortTagsRestOrder(tags: ApiTag[]): ApiTag[] {
  return [...tags].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const byName = compareTagNames(a.name, b.name);
    if (byName !== 0) return byName;
    return a.id - b.id;
  });
}

/**
 * Normalize a tag name the way the server handlers do (trim, drop
 * one leading hash, trim each slash-separated segment). Used only
 * to compare a rename against the stored name for the locked-tag
 * rule; the server remains the authority on normalization.
 */
function normalizeTagNameForCompare(value: string): string {
  return value
    .trim()
    .replace(/^#/, "")
    .split("/")
    .map((part) => part.trim())
    .join("/");
}

function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Enforce the per-type url shape rules (contract 3.5, V1-14 3.2)
 * client-side: the kind accepts any url string. Asset-key
 * existence is NOT checked here; REST enforces asset_not_found.
 */
function validateCreateUrl(body: CreateRecordBody): void {
  const url = body.url ?? "";
  const type: RecordType = body.type;
  if (type === "link") {
    if (url === "" || !isHttpUrl(url)) {
      throw new Error("Link records need a valid http or https URL.");
    }
    return;
  }
  if (type === "text" || type === "todo") {
    if (url !== "") {
      throw new Error("Text and todo records must not carry a URL.");
    }
    return;
  }
  if (url === "") {
    throw new Error("Image, file, scan, and recording records need an asset key URL.");
  }
}

/**
 * Validate todo content JSON (contract 3.5, S-05) and return the
 * title. The kind stores content opaquely, so the client enforces
 * the four-key shape: title required and non-empty, description a
 * string, priority an enum value, completed a boolean, no unknown
 * keys.
 */
function todoTitleFromContent(content: string | undefined): string {
  if (content === undefined || content === "") {
    throw new Error("Todo records need JSON content with a title.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("Todo content must be valid JSON.");
  }
  if (!isRecordValue(parsed)) {
    throw new Error("Todo content must be a JSON object.");
  }
  for (const key of Object.keys(parsed)) {
    if (
      key !== "title" &&
      key !== "description" &&
      key !== "priority" &&
      key !== "completed"
    ) {
      throw new Error("Todo content carries an unknown key.");
    }
  }
  const title = parsed.title;
  if (typeof title !== "string" || title.trim() === "") {
    throw new Error("Todo title must not be empty.");
  }
  if (
    parsed.description !== undefined &&
    typeof parsed.description !== "string"
  ) {
    throw new Error("Todo description must be a string.");
  }
  if (
    parsed.priority !== undefined &&
    parsed.priority !== "low" &&
    parsed.priority !== "medium" &&
    parsed.priority !== "high"
  ) {
    throw new Error("Todo priority must be low, medium, or high.");
  }
  if (
    parsed.completed !== undefined &&
    typeof parsed.completed !== "boolean"
  ) {
    throw new Error("Todo completed must be a boolean.");
  }
  return title.trim();
}

export class KindRecordsApi implements RecordsApiPort {
  private readonly sql: KindSqlAdapter;
  private readonly assets: KindAssetUploader;

  constructor(options: KindRecordsApiOptions) {
    this.sql = options.sql;
    this.assets = options.assets;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw translateKindError(error);
    }
  }

  // -- Records: list and read -------------------------------------------

  async listRecords(
    filters: InboxListFilters = {},
    cursor?: string,
  ): Promise<RecordListPage> {
    const status = filters.status ?? "active";
    const hasTagId =
      filters.tagId !== undefined && filters.tagId !== "all";
    const tagIdsInput = filters.tagIds ?? [];
    const hasTagIds = tagIdsInput.length > 0;
    if (hasTagId && hasTagIds) {
      throw new Error("tagId and tagIds must not be combined.");
    }
    const tagRules = filters.tagRules;
    const hasTagRules =
      tagRules !== undefined &&
      (tagRules.include.length > 0 || tagRules.exclude.length > 0);
    const hasOtherFilter =
      hasTagId ||
      hasTagIds ||
      hasTagRules ||
      (filters.types ?? []).length > 0 ||
      (filters.q ?? "").trim() !== "" ||
      filters.createdAfter !== undefined ||
      filters.createdBefore !== undefined;
    if (status === "trash" && hasOtherFilter) {
      throw new Error(
        "Trash list must not be combined with other filters.",
      );
    }
    // Filters the kinds cannot express (divergence 1). Reject
    // explicitly; page-local filtering would silently drop rows.
    if ((filters.q ?? "").trim() !== "") {
      throw new Error(
        "Inbox text filter (q) is not available over the kind path; it needs the REST list route (V3-25).",
      );
    }
    if ((filters.types ?? []).length > 0) {
      throw new Error(
        "Inbox type filter is not available over the kind path; it needs the REST list route (V3-25).",
      );
    }
    if (
      filters.createdAfter !== undefined ||
      filters.createdBefore !== undefined
    ) {
      throw new Error(
        "Inbox created range is not available over the kind path; it needs the REST list route (V3-25).",
      );
    }
    if (hasTagRules) {
      throw new Error(
        "Inbox tag rules are not available over the kind path; they need the REST list route (V3-25).",
      );
    }
    const sort = filters.sort ?? "created_desc";
    if (sort !== "created_desc") {
      throw new Error(
        "Inbox sort order other than created_desc is not available over the kind path; it needs the REST list route (V3-25).",
      );
    }
    let tagId: number | undefined;
    if (hasTagId) {
      tagId = filters.tagId as number;
    } else if (tagIdsInput.length === 1) {
      tagId = tagIdsInput[0];
    } else if (tagIdsInput.length > 1) {
      throw new Error(
        "Filtering by several tags is not available over the kind path; it needs the REST list route (V3-25).",
      );
    }
    const limit = Math.min(200, Math.max(1, Math.floor(filters.limit ?? 50)));
    const deleted: SqlDeletedFilter =
      status === "trash" ? "deleted" : status === "all" ? "all" : "active";
    // Probe one row past the page so hasMore is exact, except at
    // the 200 cap where the probe clamps to the page size and a
    // full page reports hasMore (one empty follow-up page at most).
    const probeLimit = Math.min(limit + 1, 200);
    const rows = await this.call(() =>
      tagId === undefined
        ? this.sql.query({
            kind: "marks.list",
            deleted,
            ...(cursor === undefined ? {} : { cursor }),
            limit: probeLimit,
          })
        : this.sql.query({
            kind: "marks.listByTag",
            tagId,
            deleted,
            ...(cursor === undefined ? {} : { cursor }),
            limit: probeLimit,
          }),
    );
    const kept = rows.slice(0, limit);
    const hasMore =
      rows.length > limit || (limit === 200 && rows.length === 200);
    const last = kept[kept.length - 1];
    return {
      items: kept.map((row) => toApiRecord(row)),
      nextCursor:
        hasMore && last !== undefined
          ? `${last.createdAt}:${last.id}`
          : null,
      hasMore,
    };
  }

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

  async getRecord(markId: number): Promise<ApiRecord> {
    const row = await this.call(() =>
      this.sql.queryOne({ kind: "marks.get", id: markId }),
    );
    if (row === null) {
      throw notFoundError();
    }
    return toApiRecord(row);
  }

  // -- Records: create and edit ------------------------------------------

  private async resolveDefaultTagId(): Promise<number> {
    const tags = await this.call(() => this.sql.query({ kind: "tags.list" }));
    const locked = tags.find((tag) => tag.isLocked);
    if (locked !== undefined) {
      return locked.id;
    }
    throw new Error(
      "No tag was selected and no locked default tag exists; select a tag to save the record.",
    );
  }

  async createRecord(body: CreateRecordBody): Promise<ApiRecord> {
    const tagIdsInput = body.tagIds ?? [];
    if (body.tagIds !== undefined && tagIdsInput.length === 0) {
      throw new Error("tagIds must not be empty.");
    }
    if (
      body.tagId !== undefined &&
      tagIdsInput.length > 0 &&
      !tagIdsInput.includes(body.tagId)
    ) {
      throw new Error("tagId must be a member of tagIds.");
    }
    validateCreateUrl(body);
    let desc = body.desc;
    if (body.type === "todo") {
      const title = todoTitleFromContent(body.content);
      if (desc === undefined) {
        desc = title;
      } else if (desc.trim() !== title) {
        throw new Error("Todo desc must equal the todo title.");
      }
    } else if (desc === undefined) {
      desc = body.type === "text" ? (body.content ?? "") : "";
    }
    const content = body.content ?? "";
    const url = body.url ?? "";
    let primary = body.tagId ?? tagIdsInput[0];
    let tagIds: number[];
    if (primary === undefined) {
      primary = await this.resolveDefaultTagId();
      tagIds = [primary];
    } else if (tagIdsInput.length > 0) {
      tagIds = [...new Set(tagIdsInput)];
    } else {
      tagIds = [primary];
    }
    const primaryTagId: number = primary;
    const finalTagIds = tagIds;
    const result = await this.call(() =>
      this.sql.execute({
        kind: "marks.create",
        mark: {
          tagId: primaryTagId,
          type: body.type,
          content,
          desc: desc ?? "",
          url,
          ...(body.sourceId ? { sourceId: body.sourceId } : {}),
        },
        tagIds: finalTagIds,
      }),
    );
    const id =
      typeof result.id === "number"
        ? result.id
        : typeof result.id === "string"
          ? Number(result.id)
          : NaN;
    if (!Number.isInteger(id)) {
      throw new Error("marks.create did not return a record id.");
    }
    const duplicate = result.affected === 0;
    const row = await this.call(() =>
      this.sql.queryOne({ kind: "marks.get", id }),
    );
    if (row === null) {
      throw new Error("Created record could not be read back.");
    }
    return toApiRecord(row, duplicate);
  }

  async updateRecord(
    markId: number,
    body: PatchRecordBody,
  ): Promise<ApiRecord> {
    if (
      body.content === undefined &&
      body.desc === undefined &&
      body.url === undefined
    ) {
      throw new Error(
        "PATCH record needs at least one of content, desc, url.",
      );
    }
    const patch: SqlMarkPatch = {
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.desc !== undefined ? { desc: body.desc } : {}),
      ...(body.url !== undefined ? { url: body.url } : {}),
    };
    if (body.force === true) {
      await this.call(() =>
        this.sql.execute({ kind: "marks.update", id: markId, patch }),
      );
    } else if (body.expectedVersion === undefined) {
      // DA-11-10: fail closed like updateRecordTags. A missing
      // guard used to mean an unguarded write, the same as force;
      // callers that forget expectedVersion must hear about it
      // instead of overwriting silently.
      throw new Error(
        "updateRecord needs expectedVersion unless force is true.",
      );
    } else {
      await this.call(() =>
        this.sql.execute({
          kind: "marks.update",
          id: markId,
          patch,
          expected: { version: body.expectedVersion as number },
        }),
      );
    }
    return this.getRecord(markId);
  }

  async updateRecordTags(
    markId: number,
    body: UpdateRecordTagsBody,
  ): Promise<ApiRecord> {
    if (body.tagIds.length === 0) {
      throw new Error("tagIds must not be empty.");
    }
    const tagIds = [...new Set(body.tagIds)];
    if (body.force === true) {
      await this.call(() =>
        this.sql.execute({ kind: "marks.updateTags", id: markId, tagIds }),
      );
      return this.getRecord(markId);
    }
    // The kind guard needs the current primary tag, which the
    // caller does not carry, so read the record first. The guard
    // itself is still decided server-side at write time.
    const current = await this.getRecord(markId);
    let expectedTagIds = body.expectedTagIds;
    if (expectedTagIds === undefined) {
      if (body.expectedTagVersion === undefined) {
        throw new Error(
          "updateRecordTags needs expectedTagIds unless force is true.",
        );
      }
      // Divergence 10: version guard converted to a set guard
      // from the fresh read above.
      expectedTagIds = [...current.tagIds];
    }
    const expectedSet = [...expectedTagIds];
    await this.call(() =>
      this.sql.execute({
        kind: "marks.updateTags",
        id: markId,
        tagIds,
        expected: {
          tagIds: expectedSet,
          primaryTagId: current.tagId,
        },
      }),
    );
    return this.getRecord(markId);
  }

  // -- Records: delete, restore, trash ------------------------------------

  async softDeleteRecord(markId: number): Promise<ApiRecord> {
    await this.call(() =>
      this.sql.execute({ kind: "marks.softDelete", id: markId }),
    );
    return this.getRecord(markId);
  }

  async restoreRecord(markId: number): Promise<ApiRecord> {
    await this.call(() =>
      this.sql.execute({ kind: "marks.restore", id: markId }),
    );
    return this.getRecord(markId);
  }

  async deleteRecordPermanent(
    markId: number,
  ): Promise<PermanentDeleteResult> {
    await this.call(() =>
      this.sql.execute({ kind: "marks.deletePermanent", id: markId }),
    );
    return { id: markId, deleted: true, permanent: true };
  }

  /**
   * Empty the trash via kind `marks.emptyTrash` (BUG-01): one
   * server transaction plus one activity event; the result
   * `affected` is the purged count. Never emulated per record.
   */
  async emptyTrash(): Promise<EmptyTrashResult> {
    const result = await this.call(() =>
      this.sql.execute({ kind: "marks.emptyTrash" }),
    );
    return { purged: result.affected, purgedAt: Date.now() };
  }

  // -- Tags ----------------------------------------------------------------

  async listTags(): Promise<TagList> {
    const rows = await this.call(() => this.sql.query({ kind: "tags.list" }));
    return { tags: sortTagsRestOrder(rows.map((row) => toApiTag(row))) };
  }

  async getTag(tagId: number): Promise<ApiTag> {
    const row = await this.call(() =>
      this.sql.queryOne({ kind: "tags.get", id: tagId }),
    );
    if (row === null) {
      throw notFoundError();
    }
    return toApiTag(row);
  }

  async createTag(name: string): Promise<ApiTag> {
    const result = await this.call(() =>
      this.sql.execute({ kind: "tags.create", name }),
    );
    if (result.affected === 0) {
      // Divergence 6: the kind returns the existing tag; REST
      // answers 409 tag_name_taken. Convert here.
      throw new ApiError({
        localCode: mapWireCodeToLocalCode("tag_name_taken", 409),
        wireCode: "tag_name_taken",
        status: 409,
        retryable: false,
        details: {},
      });
    }
    const id =
      typeof result.id === "number"
        ? result.id
        : typeof result.id === "string"
          ? Number(result.id)
          : NaN;
    if (!Number.isInteger(id)) {
      throw new Error("tags.create did not return a tag id.");
    }
    return this.getTag(id);
  }

  async updateTag(
    tagId: number,
    body: { name?: string; pinned?: boolean },
  ): Promise<ApiTag> {
    if (body.name === undefined && body.pinned === undefined) {
      throw new Error("PATCH tag needs at least one of name, pinned.");
    }
    const current = await this.getTag(tagId);
    const nameChanged =
      body.name !== undefined &&
      normalizeTagNameForCompare(body.name) !==
        normalizeTagNameForCompare(current.name);
    const pinChanged =
      body.pinned !== undefined && body.pinned !== current.pinned;
    if (current.locked && (nameChanged || pinChanged)) {
      // Divergence 5: enforce the contract locked-tag rule before
      // the kind runs; the kind alone would allow the pin change.
      throw new ApiError({
        localCode: mapWireCodeToLocalCode("tag_locked", 409),
        wireCode: "tag_locked",
        status: 409,
        retryable: false,
        details: {},
      });
    }
    if (!nameChanged && !pinChanged) {
      return current;
    }
    await this.call(() =>
      this.sql.execute({
        kind: "tags.rename",
        id: tagId,
        name: body.name ?? current.name,
        ...(body.pinned !== undefined ? { isPin: body.pinned } : {}),
      }),
    );
    return this.getTag(tagId);
  }

  /**
   * Delete a tag through the tags.delete kind (handler registered
   * by W4-CODEMOD, wave 4). When the tag is still in use the
   * caller passes reassignTo; without it the server answers 409
   * tag_in_use with the affected record count. Deleting a tag
   * never trashes records (D-03).
   */
  async deleteTag(
    tagId: number,
    reassignTo?: number,
  ): Promise<DeleteTagResult> {
    await this.call(() =>
      this.sql.execute({
        kind: "tags.delete",
        id: tagId,
        ...(reassignTo !== undefined ? { reassignTo } : {}),
      }),
    );
    return { id: tagId, deleted: true, reassignedTo: reassignTo ?? null };
  }

  // -- Record assets (create flows only) ------------------------------------

  uploadAsset(file: Blob, fileName?: string): Promise<UploadedAsset> {
    return this.assets.uploadAsset(file, fileName);
  }
}
