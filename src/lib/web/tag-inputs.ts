// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Pure tag input helpers for the web inbox (Fase 1, V3-26b). No fetch,
// no React, no store: every function here is unit testable without a
// server. Tag name rules follow fase1/kontrak-api-kanonis.md section
// 3.6 and fase1/desain-record-search.md (V1-14) section 5.2: a name is
// 1-100 characters after trimming, with no control characters. The
// server trims leading and trailing space and answers 409
// tag_name_taken for a duplicate name; the server stays authoritative
// and this module only rejects input the wire rules already reject.
// Tag-set order rules follow V1-14 section 3.6: the first element of
// tagIds is the primary tag, so changing only the order of a tag set
// is a real change even though the set guard compares sets.
//
// This module extends the V3-26a inbox surface (record-inputs.ts,
// records-client.ts, KindRecordsApi) with the tag pieces the 26a UI
// left out: client-side name validation with typed reasons, shared
// by tag create and rename, and primary-tag moves inside a record
// tag set. It does not add tag reorder: the contract orders tags
// pinned-first then by name, and no reorder route exists in
// contract 3.6.

/** Maximum tag name length in characters (contract 3.6, V1-14 5.2). */
export const TAG_NAME_MAX_LENGTH = 100;

/** Why a tag name fails client-side validation. */
export type TagNameProblem = "empty" | "tooLong" | "controlChars";

export type TagNameValidation =
  | { ok: true; name: string }
  | { ok: false; reason: TagNameProblem };

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Trim a tag name the way the server does before it checks length
 * and uniqueness. Inner space is kept as typed.
 */
export function normalizeTagName(name: string): string {
  return name.trim();
}

/**
 * Validate a raw tag name against the wire rules. Length counts
 * Unicode code points, so one astral character counts as one
 * character; the server count stays authoritative. A name that is
 * both too long and contains a control character reports
 * "controlChars" first, so an invisible character is not hidden
 * behind a length complaint.
 */
export function validateTagName(rawName: string): TagNameValidation {
  const name = normalizeTagName(rawName);
  if (name === "") {
    return { ok: false, reason: "empty" };
  }
  if (CONTROL_CHAR_PATTERN.test(name)) {
    return { ok: false, reason: "controlChars" };
  }
  if ([...name].length > TAG_NAME_MAX_LENGTH) {
    return { ok: false, reason: "tooLong" };
  }
  return { ok: true, name };
}

/**
 * Set equality for tag id lists, ignoring order. This is the
 * comparison the set guard uses (V1-14 3.6: expectedTagIds match by
 * set equality). Inputs are assumed duplicate-free, as the wire
 * rules require; duplicates are not normalized here.
 */
export function sameTagSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const inB = new Set(b);
  return a.every((id) => inB.has(id));
}

/**
 * True when a draft tag selection differs from the stored one in
 * set or in order. Order matters because the first element is the
 * primary tag: moving a tag to the front changes the record even
 * though the set is unchanged, so an order-only change must enable
 * saving.
 */
export function tagSelectionChanged(
  current: readonly number[],
  next: readonly number[],
): boolean {
  if (current.length !== next.length) return true;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== next[index]) return true;
  }
  return false;
}

/**
 * Move one tag to the front of a tag id list, making it the primary
 * tag. The remaining ids keep their relative order. When the tag is
 * not in the list, a copy of the list is returned unchanged; the UI
 * only offers tags that are already selected.
 */
export function setPrimaryTag(
  tagIds: readonly number[],
  tagId: number,
): number[] {
  if (!tagIds.includes(tagId)) return [...tagIds];
  return [tagId, ...tagIds.filter((id) => id !== tagId)];
}
