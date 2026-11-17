// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Pure tag name helpers for the web inbox (Fase 1, V3-26b). No fetch,
// no React, no store: every function here is unit testable without a
// server. Tag name rules follow fase1/kontrak-api-kanonis.md section
// 3.6 and fase1/desain-record-search.md (V1-14) section 5.2: a name is
// 1-100 characters after trimming, with no control characters. The
// server trims leading and trailing space and answers 409
// tag_name_taken for a duplicate name; the server stays authoritative
// and this module only rejects input the wire rules already reject.
//
// This module extends the V3-26a inbox surface (record-inputs.ts,
// records-client.ts, KindRecordsApi) with the tag name validation
// the 26a sidebar lacked, shared by tag create and rename with typed
// reasons so the UI can name the problem. It deliberately offers no
// primary-tag move: the live kind path (marks.updateTags) never
// changes the primary tag, and the kind that does (marks.saveTagIds)
// carries no optimistic guard, so a primary control would either
// no-op silently or bypass the set guard. Primary changes follow the
// REST PUT order rule (V1-14 3.6) once the V3-25 routes land. It
// also offers no tag reorder: the contract orders tags pinned-first
// then by name, and no reorder route exists in contract 3.6.

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
