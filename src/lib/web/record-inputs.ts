// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Pure input builders for the web inbox (Fase 1, V3-26). No fetch,
// no React, no store: every function here is unit testable without a
// server. Wire shapes follow fase1/kontrak-api-kanonis.md sections
// 3.5-3.8 (canonical paths /api/marks and /api/tags, no /v1 prefix,
// no workspaceId in requests) and the record design in
// fase1/desain-record-search.md (V1-14) sections 2-7 as amended by
// A-12 (tag rules, sort=type, substring list q, trash filter ban).
//
// The five MVP create flows (V1-14 section 7.3) are text, link,
// image (paste/upload), file (upload), and todo. Recording and
// scan/OS capture are NOT opened by the MVP UI and have no builder
// here; the UI shows them disabled with honest copy instead.
// Enrichment jobs and the clipper do not exist in the MVP (V1-14
// section 7) and nothing here calls them.

export type RecordType =
  | "scan"
  | "text"
  | "image"
  | "link"
  | "file"
  | "recording"
  | "todo";

/** The five record types the MVP UI opens a create flow for. */
export const MVP_CREATE_TYPES: readonly RecordType[] = [
  "text",
  "link",
  "image",
  "file",
  "todo",
];

export type TodoPriority = "low" | "medium" | "high";

export interface TodoData {
  title: string;
  description: string;
  priority: TodoPriority;
  completed: boolean;
}

export const TODO_PRIORITIES: readonly TodoPriority[] = [
  "low",
  "medium",
  "high",
];

export function isTodoPriority(value: unknown): value is TodoPriority {
  return value === "low" || value === "medium" || value === "high";
}

/**
 * Parse a todo record body tolerantly, mirroring the upstream
 * parseTodoMarkContent fallback: invalid JSON renders with the title
 * from desc, an empty description, medium priority, and not
 * completed. The first WRITE through the API must produce valid
 * JSON (contract 3.5, S-05); see buildTodoContent.
 */
export function parseTodoContent(
  content: string | undefined | null,
  desc: string | undefined | null,
): TodoData {
  const fallback: TodoData = {
    title: (desc ?? "").trim(),
    description: "",
    priority: "medium",
    completed: false,
  };
  if (!content) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;
  const obj = parsed as Record<string, unknown>;
  const title =
    typeof obj.title === "string" && obj.title.trim() !== ""
      ? obj.title.trim()
      : fallback.title;
  return {
    title,
    description: typeof obj.description === "string" ? obj.description : "",
    priority: isTodoPriority(obj.priority) ? obj.priority : "medium",
    completed: Boolean(obj.completed),
  };
}

/**
 * Build the JSON string a todo record stores in `content`
 * (contract 3.5, S-05): exactly the four keys title, description,
 * priority, completed. Throws when the title is empty after trim;
 * the UI validates before calling this.
 */
export function buildTodoContent(todo: {
  title: string;
  description?: string;
  priority?: TodoPriority;
  completed?: boolean;
}): string {
  const title = todo.title.trim();
  if (title === "") {
    throw new Error("Todo title must not be empty.");
  }
  const data: TodoData = {
    title,
    description: todo.description ?? "",
    priority: todo.priority ?? "medium",
    completed: todo.completed ?? false,
  };
  return JSON.stringify(data);
}

export interface CreateRecordBody {
  type: RecordType;
  content?: string;
  desc?: string;
  url?: string;
  tagId?: number;
  tagIds?: number[];
  sourceId?: string;
}

/**
 * F02-09: decide whether a duplicate create answer (first-write-wins
 * on sourceId) carries the same payload the caller just sent. When
 * it does not, the draft was edited after the first save committed,
 * and closing the dialog as success would silently drop the edits.
 */
export function createBodyMatchesRecord(
  body: CreateRecordBody,
  record: { content: string; desc: string; url: string },
): boolean {
  if (body.content !== undefined && body.content !== record.content) return false;
  if (body.desc !== undefined && body.desc !== record.desc) return false;
  if (body.url !== undefined && body.url !== record.url) return false;
  return true;
}

/** Tag selection shared by all five create flows. */
export interface CreateTagSelection {
  tagIds?: number[];
}

/**
 * Resolve the tag fields for a create body. When the caller passes
 * no tags, both fields stay absent so the server resolves the
 * default save target (V1-14 section 3.7); the client must not
 * guess the target itself. When tags are given, the first one is
 * the primary tag.
 */
export function resolveCreateTags(
  selection: CreateTagSelection,
): Pick<CreateRecordBody, "tagId" | "tagIds"> {
  const tagIds = (selection.tagIds ?? []).filter(
    (id, index, all) => Number.isInteger(id) && all.indexOf(id) === index,
  );
  if (tagIds.length === 0) return {};
  return { tagId: tagIds[0], tagIds };
}

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function randomSuffix(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
}

/**
 * Build a sourceId for one user create action (contract 3.5, D-05).
 * The caller generates it ONCE per action and reuses it for retries
 * of that same action, so a retry is answered 200 + duplicate
 * instead of creating a second record. The content hash plus a
 * random suffix keeps two identical pastes as two records while
 * keeping retries of one action idempotent. Prefixes follow V1-14
 * section 3.4 (web:paste / web:upload); the clipper and share
 * prefixes are reserved for later phases and are never produced
 * here.
 */
export function makeSourceId(
  kind: "paste" | "upload",
  seed: string,
): string {
  const prefix = kind === "paste" ? "web:paste" : "web:upload";
  return `${prefix}:${fnv1aHex(seed)}-${randomSuffix()}`;
}

/** Text flow: content and desc carry the same text; no url. */
export function buildTextCreateBody(
  text: string,
  selection: CreateTagSelection,
  sourceId?: string,
): CreateRecordBody {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("Text must not be empty.");
  }
  return {
    type: "text",
    content: text,
    desc: text,
    ...resolveCreateTags(selection),
    ...(sourceId ? { sourceId } : {}),
  };
}

/**
 * Link flow: the URL is saved as entered, without fetching (V1-14
 * section 7.1: no link-enrich job in the MVP). A missing scheme is
 * the only normalization, mirroring upstream capture: a bare
 * host becomes https://host so the value is a valid HTTP(S) URL.
 * desc is the URL itself because no page title is fetched.
 */
export function normalizeLinkUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("Link URL must not be empty.");
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Link URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Link URL must use http or https.");
  }
  return withScheme;
}

export function buildLinkCreateBody(
  rawUrl: string,
  selection: CreateTagSelection,
  sourceId?: string,
): CreateRecordBody {
  const url = normalizeLinkUrl(rawUrl);
  return {
    type: "link",
    content: "",
    desc: url,
    url,
    ...resolveCreateTags(selection),
    ...(sourceId ? { sourceId } : {}),
  };
}

/**
 * Image flow: the asset must already be uploaded (POST /api/assets);
 * the record stores the opaque asset key as url and an empty
 * content, because image recognition does not exist in the MVP.
 */
export function buildImageCreateBody(
  assetKey: string,
  caption: string,
  selection: CreateTagSelection,
  sourceId?: string,
): CreateRecordBody {
  if (assetKey.trim() === "") {
    throw new Error("Image asset key must not be empty.");
  }
  return {
    type: "image",
    content: "",
    desc: caption,
    url: assetKey,
    ...resolveCreateTags(selection),
    ...(sourceId ? { sourceId } : {}),
  };
}

/** File flow: same shape as image; desc defaults to the file name. */
export function buildFileCreateBody(
  assetKey: string,
  fileName: string,
  caption: string | undefined,
  selection: CreateTagSelection,
  sourceId?: string,
): CreateRecordBody {
  if (assetKey.trim() === "") {
    throw new Error("File asset key must not be empty.");
  }
  return {
    type: "file",
    content: "",
    desc: caption ?? fileName,
    url: assetKey,
    ...resolveCreateTags(selection),
    ...(sourceId ? { sourceId } : {}),
  };
}

/**
 * Todo flow (contract 3.5, S-05): content is the four-field JSON
 * object, desc MUST equal the trimmed title, and url stays absent.
 */
export function buildTodoCreateBody(
  todo: {
    title: string;
    description?: string;
    priority?: TodoPriority;
    completed?: boolean;
  },
  selection: CreateTagSelection,
  sourceId?: string,
): CreateRecordBody {
  const content = buildTodoContent(todo);
  return {
    type: "todo",
    content,
    desc: parseTodoContent(content, "").title,
    ...resolveCreateTags(selection),
    ...(sourceId ? { sourceId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Inbox list query (V1-14 section 6.1 as amended by A-12)
// ---------------------------------------------------------------------------

export type InboxSortMode =
  | "created_desc"
  | "created_asc"
  | "updated_desc"
  | "type";

export type InboxStatus = "active" | "trash" | "all";

export type TimePreset = "all" | "today" | "last7Days" | "last30Days";

export interface TagRulesFilter {
  include: string[];
  exclude: string[];
  match: "all" | "any";
}

export interface InboxListFilters {
  tagId?: number | "all";
  tagIds?: number[];
  tagRules?: TagRulesFilter;
  types?: RecordType[];
  status?: InboxStatus;
  /** Substring filter; matching is server-side, never client-side. */
  q?: string;
  createdAfter?: number;
  createdBefore?: number;
  sort?: InboxSortMode;
  limit?: number;
}

export interface InboxListQuery {
  [key: string]: string | number | undefined;
}

/**
 * Build the query object for GET /api/marks. Enforces the A-12
 * combination rules client-side so invalid combinations fail fast
 * with a local error instead of a server 400: tagId and tagIds are
 * mutually exclusive, and status=trash accepts no filter other
 * than sort/cursor/limit. The caller must clear filters before
 * requesting the trash list.
 */
export function buildListQuery(
  filters: InboxListFilters,
  cursor?: string,
): InboxListQuery {
  const status = filters.status ?? "active";
  const hasTagId =
    filters.tagId !== undefined && filters.tagId !== "all";
  const hasTagIds = (filters.tagIds ?? []).length > 0;
  if (hasTagId && hasTagIds) {
    throw new Error("tagId and tagIds must not be combined.");
  }
  const hasOtherFilter =
    hasTagId ||
    hasTagIds ||
    (filters.tagRules !== undefined &&
      (filters.tagRules.include.length > 0 ||
        filters.tagRules.exclude.length > 0)) ||
    (filters.types ?? []).length > 0 ||
    (filters.q ?? "").trim() !== "" ||
    filters.createdAfter !== undefined ||
    filters.createdBefore !== undefined;
  if (status === "trash" && hasOtherFilter) {
    throw new Error(
      "Trash list must not be combined with other filters.",
    );
  }
  const query: InboxListQuery = { status };
  if (hasTagId) query.tagId = filters.tagId as number;
  if (hasTagIds) query.tagIds = filters.tagIds!.join(",");
  if (filters.tagRules !== undefined) {
    const include = filters.tagRules.include
      .map((path) => path.trim())
      .filter((path) => path !== "");
    const exclude = filters.tagRules.exclude
      .map((path) => path.trim())
      .filter((path) => path !== "");
    if (include.length > 0) {
      query.tagInclude = [...new Set(include)].join(",");
      query.tagMatch = filters.tagRules.match;
    }
    if (exclude.length > 0) {
      query.tagExclude = [...new Set(exclude)].join(",");
    }
  }
  if ((filters.types ?? []).length > 0) {
    query.type = filters.types!.join(",");
  }
  const q = (filters.q ?? "").trim();
  if (q !== "") query.q = q;
  if (filters.createdAfter !== undefined) {
    query.createdAfter = filters.createdAfter;
  }
  if (filters.createdBefore !== undefined) {
    query.createdBefore = filters.createdBefore;
  }
  query.sort = filters.sort ?? "created_desc";
  const limit = filters.limit ?? 50;
  query.limit = Math.min(200, Math.max(1, Math.floor(limit)));
  if (cursor) query.cursor = cursor;
  return query;
}

/**
 * Convert a desktop time preset to a createdAfter/createdBefore
 * range using the device local timezone (A-12: the server never
 * guesses the client timezone). `today` spans local midnight to
 * the next local midnight; last7Days/last30Days span back from
 * now and exclude future-dated records.
 */
export function timePresetToRange(
  preset: TimePreset,
  now: Date = new Date(),
): { createdAfter?: number; createdBefore?: number } {
  if (preset === "all") return {};
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return {
      createdAfter: start.getTime(),
      createdBefore: end.getTime() - 1,
    };
  }
  const days = preset === "last7Days" ? 7 : 30;
  return {
    createdAfter: now.getTime() - days * 24 * 60 * 60 * 1000,
    createdBefore: now.getTime(),
  };
}

/**
 * Display title for a record, following the search contract title
 * rule (V1-14 section 8.2): desc first, then the first 80
 * characters of content, then the file name for asset records.
 */
export function recordDisplayTitle(record: {
  desc?: string | null;
  content?: string | null;
  fileName?: string | null;
  type: RecordType;
}): string {
  const desc = (record.desc ?? "").trim();
  if (desc !== "") return desc;
  const content = (record.content ?? "").trim();
  if (content !== "") return content.slice(0, 80);
  return (record.fileName ?? "").trim();
}

/**
 * True when the record is of a type whose content would come from
 * an enrichment job (link, image, file, scan, recording) and the
 * content is still empty. The detail view shows the V1-14 section
 * 7.4 "no extracted content" copy for these records; emptiness is
 * stated behavior in the MVP, never a failure.
 */
export function hasNoExtractedContent(record: {
  type: RecordType;
  content?: string | null;
}): boolean {
  if (
    record.type !== "link" &&
    record.type !== "image" &&
    record.type !== "file" &&
    record.type !== "scan" &&
    record.type !== "recording"
  ) {
    return false;
  }
  return (record.content ?? "") === "";
}

/** Serve URL for a record asset key (contract 3.7): fully encoded. */
export function recordAssetUrl(assetKey: string): string {
  return `/api/assets/${encodeURIComponent(assetKey)}`;
}
