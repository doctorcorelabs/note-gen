// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Pure request parsing and validation for the REST marks/tags
// routes (W4-WIRE, kontrak 3.5/3.6, V1-14 sections 3, 5, 6.1 as
// amended by A-12 and AD-32). Nothing here touches the database
// or the disk: existence checks (tags, assets, workspaces) live
// in the repository. Every parser throws ApiError with the
// contract code; unknown body fields are rejected (kontrak
// K-09), never ignored.
//
// Rules that need a home note:
// - The canonical contract wins over V1-14 text where they
//   differ: no /api/v1, no workspace id in the request, the
//   canonical Idempotency-Key header (not X-Idempotency-Key),
//   409 revision_conflict (not version_conflict) for PATCH
//   guards, locked-tag pin changes forbidden (S-32), and the
//   list `q` is one substring, not the search endpoint's
//   multi-term matching.
// - Todo writes follow S-05: content must be JSON with exactly
//   the four keys title, description, priority, completed;
//   desc must equal the trimmed title; url must be empty.
//   Reads tolerate legacy non-JSON todo content, but writes
//   never produce it.
// - tagVersion has no column (see represent.ts): the wire
//   tagVersion aliases version, and expectedTagVersion is
//   compared against version.

import { randomUUID } from 'node:crypto';
import { ApiError } from '../../plugins/envelope.js';
import {
  fieldError,
  rejectUnknownFields,
  requireJsonObject,
} from '../workspace/write-guards.js';
import { normalizeTagName, TAG_NAME_MAX_LENGTH } from '../db/tags-create.js';

export type RecordType = 'scan' | 'text' | 'image' | 'link' | 'file' | 'recording' | 'todo';

export const RECORD_TYPES: ReadonlySet<string> = new Set([
  'scan',
  'text',
  'image',
  'link',
  'file',
  'recording',
  'todo',
]);

const ASSET_TYPES: ReadonlySet<RecordType> = new Set(['image', 'file', 'recording', 'scan']);

export const SOURCE_ID_MAX_LENGTH = 255;

export interface CreateRecordInput {
  type: RecordType;
  content: string;
  desc: string;
  url: string;
  tagId: number | undefined;
  tagIds: number[] | undefined;
  sourceId: string;
}

export interface PatchRecordInput {
  content: string | undefined;
  desc: string | undefined;
  url: string | undefined;
  expectedVersion: number | undefined;
  force: boolean;
}

export interface PutTagsInput {
  tagIds: number[];
  expectedTagIds: number[] | undefined;
  expectedTagVersion: number | undefined;
  force: boolean;
}

export type ListStatus = 'active' | 'trash' | 'all';
export type ListSort = 'created_desc' | 'created_asc' | 'updated_desc' | 'type';
export type TagMatch = 'all' | 'any';

export interface ListQuery {
  status: ListStatus;
  tagId: number | undefined;
  tagIds: number[] | undefined;
  tagInclude: string[] | undefined;
  tagExclude: string[] | undefined;
  tagMatch: TagMatch;
  types: RecordType[] | undefined;
  q: string | undefined;
  createdAfter: number | undefined;
  createdBefore: number | undefined;
  sort: ListSort;
  limit: number;
  cursor: string | undefined;
}

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function invalidLimit(): ApiError {
  return new ApiError(400, 'invalid_limit', 'The pagination limit is not valid.');
}

function parseIdParam(raw: unknown): number {
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw ApiError.notFound();
}

export function parseMarkIdParam(raw: unknown): number {
  return parseIdParam(raw);
}

export function parseTagIdParam(raw: unknown): number {
  return parseIdParam(raw);
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw fieldError(field, 'must be a string');
  }
  return value;
}

function parseTagIdArray(value: unknown, field: string, allowEmpty: boolean): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => isPositiveInteger(entry))) {
    throw fieldError(field, 'must be an array of positive integers');
  }
  if (!allowEmpty && value.length === 0) {
    throw fieldError(field, 'must not be empty');
  }
  return [...value];
}

export interface TodoContent {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  completed: boolean;
}

const TODO_KEYS: ReadonlySet<string> = new Set(['title', 'description', 'priority', 'completed']);

// Strict S-05 validation for todo writes: exactly the four
// keys, a non-empty trimmed title, a string description, a
// known priority, and a boolean completed flag.
export function validateTodoContent(content: string): TodoContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw fieldError('content', 'must be valid todo JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw fieldError('content', 'must be a todo JSON object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!TODO_KEYS.has(key)) {
      throw fieldError('content', 'must contain only title, description, priority, completed');
    }
  }
  const title = record['title'];
  if (typeof title !== 'string' || title.trim() === '') {
    throw fieldError('content', 'todo title must not be empty');
  }
  const description = record['description'];
  if (typeof description !== 'string') {
    throw fieldError('content', 'todo description must be a string');
  }
  const priority = record['priority'];
  if (priority !== 'low' && priority !== 'medium' && priority !== 'high') {
    throw fieldError('content', 'todo priority must be low, medium, or high');
  }
  const completed = record['completed'];
  if (typeof completed !== 'boolean') {
    throw fieldError('content', 'todo completed must be a boolean');
  }
  return { title: title.trim(), description, priority, completed };
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// URL shape rules per type (V1-14 3.2). Asset-key existence is
// checked by the repository, which owns the asset store; this
// function only pins the shape: link requires a valid
// http/https URL, text/todo require an empty url, asset types
// require a non-empty url.
export function validateUrlShape(type: RecordType, url: string): void {
  if (type === 'link') {
    if (url === '' || !isValidHttpUrl(url)) {
      throw fieldError('url', 'must be a valid http or https URL');
    }
    return;
  }
  if (type === 'text' || type === 'todo') {
    if (url !== '') {
      throw fieldError('url', 'must be empty for this record type');
    }
    return;
  }
  if (ASSET_TYPES.has(type) && url === '') {
    throw fieldError('url', 'must be an asset key for this record type');
  }
}

function resolveSourceId(bodySourceId: string | undefined, headerKey: string | undefined): string {
  const fromBody = bodySourceId !== undefined && bodySourceId !== '' ? bodySourceId : undefined;
  if (fromBody !== undefined) {
    return fromBody;
  }
  const fromHeader = headerKey !== undefined && headerKey !== '' ? headerKey : undefined;
  if (fromHeader !== undefined) {
    return fromHeader;
  }
  return randomUUID();
}

export function parseCreateBody(
  body: unknown,
  idempotencyKeyHeader: string | string[] | undefined,
): CreateRecordInput {
  const record = requireJsonObject(body);
  rejectUnknownFields(record, ['type', 'content', 'desc', 'url', 'tagId', 'tagIds', 'sourceId']);
  const rawType = record['type'];
  if (typeof rawType !== 'string' || !RECORD_TYPES.has(rawType)) {
    throw fieldError('type', 'must be a known record type');
  }
  const type = rawType as RecordType;
  const content = parseOptionalString(record['content'], 'content') ?? '';
  const rawDesc = parseOptionalString(record['desc'], 'desc');
  const url = parseOptionalString(record['url'], 'url') ?? '';
  const rawTagId = record['tagId'];
  if (rawTagId !== undefined && !isPositiveInteger(rawTagId)) {
    throw fieldError('tagId', 'must be a positive integer');
  }
  const tagId = rawTagId as number | undefined;
  const tagIds = parseTagIdArray(record['tagIds'], 'tagIds', false);
  if (tagId !== undefined && tagIds !== undefined && !tagIds.includes(tagId)) {
    throw fieldError('tagId', 'must be a member of tagIds');
  }
  const rawSourceId = parseOptionalString(record['sourceId'], 'sourceId');
  if (rawSourceId !== undefined && rawSourceId.length > SOURCE_ID_MAX_LENGTH) {
    throw fieldError('sourceId', `must be at most ${SOURCE_ID_MAX_LENGTH} characters`);
  }
  // Desc defaults (V1-14 3.2, S-05 exception): text defaults
  // desc to content; todo defaults desc to the parsed title,
  // never to the JSON envelope; other types default to empty.
  // An explicit todo desc must equal the trimmed title.
  let desc: string;
  if (type === 'todo') {
    const todo = validateTodoContent(content);
    if (rawDesc !== undefined && rawDesc !== todo.title) {
      throw fieldError('desc', 'must equal the todo title');
    }
    desc = rawDesc ?? todo.title;
  } else if (rawDesc !== undefined) {
    desc = rawDesc;
  } else if (type === 'text') {
    desc = content;
  } else {
    desc = '';
  }
  validateUrlShape(type, url);
  const headerKey =
    typeof idempotencyKeyHeader === 'string' ? idempotencyKeyHeader : undefined;
  return { type, content, desc, url, tagId, tagIds, sourceId: resolveSourceId(rawSourceId, headerKey) };
}

function parseIfMatchHeader(raw: string | string[] | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw fieldError('If-Match', 'must be a version number');
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw fieldError('If-Match', 'must be a version number');
  }
  return parsed;
}

export function parsePatchBody(
  body: unknown,
  ifMatchHeader: string | string[] | undefined,
): PatchRecordInput {
  const record = requireJsonObject(body);
  rejectUnknownFields(record, ['content', 'desc', 'url', 'expectedVersion', 'force']);
  const content = parseOptionalString(record['content'], 'content');
  const desc = parseOptionalString(record['desc'], 'desc');
  const url = parseOptionalString(record['url'], 'url');
  if (content === undefined && desc === undefined && url === undefined) {
    throw fieldError('body', 'must include at least one of content, desc, url');
  }
  const rawExpected = record['expectedVersion'];
  if (rawExpected !== undefined && !isPositiveInteger(rawExpected)) {
    throw fieldError('expectedVersion', 'must be a positive integer');
  }
  const headerGuard = parseIfMatchHeader(ifMatchHeader);
  if (headerGuard !== undefined && rawExpected !== undefined && headerGuard !== rawExpected) {
    throw fieldError('expectedVersion', 'must match the If-Match header');
  }
  const rawForce = record['force'];
  if (rawForce !== undefined && typeof rawForce !== 'boolean') {
    throw fieldError('force', 'must be a boolean');
  }
  const expectedVersion = (rawExpected as number | undefined) ?? headerGuard;
  const force = rawForce === true;
  // DA-11-08 parity (DATA2D-4, AD-799): fail closed like PUT tags and
  // the client kind. Without a guard the PATCH used to fall back to
  // last-write-wins; now a missing expectedVersion/If-Match is a 400
  // unless the caller explicitly forces the overwrite.
  if (expectedVersion === undefined && !force) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'expectedVersion', issue: 'is required unless force is true' }],
    });
  }
  return {
    content,
    desc,
    url,
    expectedVersion,
    force,
  };
}

export function parsePutTagsBody(body: unknown): PutTagsInput {
  const record = requireJsonObject(body);
  rejectUnknownFields(record, ['tagIds', 'expectedTagIds', 'expectedTagVersion', 'force']);
  const tagIds = parseTagIdArray(record['tagIds'], 'tagIds', false);
  if (tagIds === undefined) {
    throw fieldError('tagIds', 'is required');
  }
  if (new Set(tagIds).size !== tagIds.length) {
    throw fieldError('tagIds', 'must not contain duplicates');
  }
  const expectedTagIds = parseTagIdArray(record['expectedTagIds'], 'expectedTagIds', false);
  const rawExpectedVersion = record['expectedTagVersion'];
  if (rawExpectedVersion !== undefined && !isPositiveInteger(rawExpectedVersion)) {
    throw fieldError('expectedTagVersion', 'must be a positive integer');
  }
  const rawForce = record['force'];
  if (rawForce !== undefined && typeof rawForce !== 'boolean') {
    throw fieldError('force', 'must be a boolean');
  }
  const force = rawForce === true;
  if (expectedTagIds === undefined && rawExpectedVersion === undefined && !force) {
    throw ApiError.validation('Request validation failed.', {
      fields: [{ field: 'expectedTagIds', issue: 'is required unless force is true' }],
    });
  }
  return {
    tagIds,
    expectedTagIds,
    expectedTagVersion: rawExpectedVersion as number | undefined,
    force,
  };
}

export function parseTagCreateBody(body: unknown): { name: string } {
  const record = requireJsonObject(body);
  rejectUnknownFields(record, ['name']);
  const raw = record['name'];
  if (typeof raw !== 'string') {
    throw fieldError('name', 'must be a string');
  }
  if (/[\x00-\x1F\x7F]/.test(raw)) {
    throw fieldError('name', 'must not contain control characters');
  }
  const normalized = normalizeTagName(raw);
  if (normalized === null) {
    throw fieldError('name', 'must have non-empty segments');
  }
  if (normalized.length > TAG_NAME_MAX_LENGTH) {
    throw fieldError('name', `must be at most ${TAG_NAME_MAX_LENGTH} characters`);
  }
  return { name: normalized };
}

export function parseTagPatchBody(body: unknown): { name: string | undefined; pinned: boolean | undefined } {
  const record = requireJsonObject(body);
  rejectUnknownFields(record, ['name', 'pinned']);
  let name: string | undefined;
  const rawName = record['name'];
  if (rawName !== undefined) {
    if (typeof rawName !== 'string') {
      throw fieldError('name', 'must be a string');
    }
    if (/[\x00-\x1F\x7F]/.test(rawName)) {
      throw fieldError('name', 'must not contain control characters');
    }
    const normalized = normalizeTagName(rawName);
    if (normalized === null) {
      throw fieldError('name', 'must have non-empty segments');
    }
    if (normalized.length > TAG_NAME_MAX_LENGTH) {
      throw fieldError('name', `must be at most ${TAG_NAME_MAX_LENGTH} characters`);
    }
    name = normalized;
  }
  const rawPinned = record['pinned'];
  if (rawPinned !== undefined && typeof rawPinned !== 'boolean') {
    throw fieldError('pinned', 'must be a boolean');
  }
  if (name === undefined && rawPinned === undefined) {
    throw fieldError('body', 'must include at least one of name, pinned');
  }
  return { name, pinned: rawPinned as boolean | undefined };
}

function parseCommaIds(raw: string, field: string): number[] {
  const parts = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
  const ids: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      throw fieldError(field, 'must be comma-separated positive integers');
    }
    const parsed = Number(part);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw fieldError(field, 'must be comma-separated positive integers');
    }
    ids.push(parsed);
  }
  return ids;
}

function parseCommaStrings(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed !== '' && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function parseEpochMs(raw: string, field: string): number {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw fieldError(field, 'must be epoch milliseconds');
  }
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw fieldError(field, 'must be epoch milliseconds');
  }
  return parsed;
}

function singleQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

export function parseListQuery(query: unknown): ListQuery {
  const record =
    typeof query === 'object' && query !== null && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const rawStatus = singleQueryValue(record['status']);
  const status: ListStatus = rawStatus === undefined ? 'active' : (rawStatus as ListStatus);
  if (status !== 'active' && status !== 'trash' && status !== 'all') {
    throw fieldError('status', 'must be active, trash, or all');
  }
  const rawTagId = singleQueryValue(record['tagId']);
  let tagId: number | undefined;
  if (rawTagId !== undefined && rawTagId !== '') {
    if (!/^\d+$/.test(rawTagId.trim())) {
      throw fieldError('tagId', 'must be a positive integer');
    }
    tagId = Number(rawTagId.trim());
    if (!Number.isSafeInteger(tagId) || tagId <= 0) {
      throw fieldError('tagId', 'must be a positive integer');
    }
  }
  const rawTagIds = singleQueryValue(record['tagIds']);
  const tagIds = rawTagIds !== undefined && rawTagIds.trim() !== '' ? parseCommaIds(rawTagIds, 'tagIds') : undefined;
  if (tagId !== undefined && tagIds !== undefined) {
    throw fieldError('tagId', 'must not be combined with tagIds');
  }
  const rawInclude = singleQueryValue(record['tagInclude']);
  const tagInclude =
    rawInclude !== undefined && rawInclude.trim() !== '' ? parseCommaStrings(rawInclude) : undefined;
  const rawExclude = singleQueryValue(record['tagExclude']);
  const tagExclude =
    rawExclude !== undefined && rawExclude.trim() !== '' ? parseCommaStrings(rawExclude) : undefined;
  const rawMatch = singleQueryValue(record['tagMatch']);
  const tagMatch: TagMatch = rawMatch === undefined ? 'all' : (rawMatch as TagMatch);
  if (tagMatch !== 'all' && tagMatch !== 'any') {
    throw fieldError('tagMatch', 'must be all or any');
  }
  const rawType = singleQueryValue(record['type']);
  let types: RecordType[] | undefined;
  if (rawType !== undefined && rawType.trim() !== '') {
    types = [];
    for (const token of parseCommaStrings(rawType)) {
      if (!RECORD_TYPES.has(token)) {
        throw fieldError('type', 'must be a known record type');
      }
      types.push(token as RecordType);
    }
    if (types.length === 0) {
      types = undefined;
    }
  }
  const rawQ = singleQueryValue(record['q']);
  const q = rawQ !== undefined && rawQ.trim() !== '' ? rawQ.trim() : undefined;
  const rawAfter = singleQueryValue(record['createdAfter']);
  const createdAfter = rawAfter !== undefined && rawAfter.trim() !== '' ? parseEpochMs(rawAfter, 'createdAfter') : undefined;
  const rawBefore = singleQueryValue(record['createdBefore']);
  const createdBefore =
    rawBefore !== undefined && rawBefore.trim() !== '' ? parseEpochMs(rawBefore, 'createdBefore') : undefined;
  const rawSort = singleQueryValue(record['sort']);
  const sort: ListSort = rawSort === undefined ? 'created_desc' : (rawSort as ListSort);
  if (sort !== 'created_desc' && sort !== 'created_asc' && sort !== 'updated_desc' && sort !== 'type') {
    throw fieldError('sort', 'must be created_desc, created_asc, updated_desc, or type');
  }
  const rawLimit = singleQueryValue(record['limit']);
  let limit = LIST_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit.trim() !== '') {
    if (!/^\d+$/.test(rawLimit.trim())) {
      throw invalidLimit();
    }
    limit = Number(rawLimit.trim());
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
      throw invalidLimit();
    }
  }
  const rawCursor = singleQueryValue(record['cursor']);
  const cursor = rawCursor !== undefined && rawCursor !== '' ? rawCursor : undefined;
  const hasOtherFilter =
    tagId !== undefined ||
    tagIds !== undefined ||
    tagInclude !== undefined ||
    tagExclude !== undefined ||
    types !== undefined ||
    q !== undefined ||
    createdAfter !== undefined ||
    createdBefore !== undefined;
  if (status === 'trash' && hasOtherFilter) {
    throw fieldError('status', 'trash must not be combined with other filters');
  }
  return {
    status,
    tagId,
    tagIds,
    tagInclude,
    tagExclude,
    tagMatch,
    types,
    q,
    createdAfter,
    createdBefore,
    sort,
    limit,
    cursor,
  };
}

export function parseEmptyTrashBody(body: unknown): void {
  if (body === undefined) {
    throw new ApiError(400, 'confirm_required', 'Confirmation is required to empty the trash.');
  }
  const record = requireJsonObject(body);
  rejectUnknownFields(record, ['confirm']);
  if (record['confirm'] !== true) {
    throw new ApiError(400, 'confirm_required', 'Confirmation is required to empty the trash.');
  }
}

export function parseReassignTo(query: unknown): number | undefined {
  const record =
    typeof query === 'object' && query !== null && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const raw = singleQueryValue(record['reassignTo']);
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw fieldError('reassignTo', 'must be a positive integer');
  }
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw fieldError('reassignTo', 'must be a positive integer');
  }
  return parsed;
}

export function parseRestoreBody(body: unknown): void {
  if (body === undefined) {
    return;
  }
  const record = requireJsonObject(body);
  rejectUnknownFields(record, []);
}
