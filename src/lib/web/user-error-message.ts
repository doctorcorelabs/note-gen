// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Shared user-facing error formatter (DA-2, BUG-07 / E27-04).
//
// Before this module, dozens of toast sites rendered
// error.message / String(error) directly, leaking internal text
// (wire codes, HTTP statuses, asset URLs, legacy facade messages)
// to the user. The only honest patterns were the wiki formatter
// (use-wiki-error-message.ts) and tagErrorNotice in the tag
// sidebar, each local to its surface.
//
// userErrorMessageKey is the single pure mapping from an unknown
// thrown value to an i18n key. It never returns raw message text:
// the raw error belongs in console.error at the call site, not in
// a toast description. UI code resolves the key through next-intl
// (useUserErrorMessage); non-hook code resolves it through
// createTranslator. Returning null means "stay silent" and is
// reserved for user-initiated aborts (AbortError), matching the
// existing handleAIError behavior.
//
// Mapping order:
// 1. Specific wire codes that carry actionable user text
//    (errors.<wire_code>).
// 2. The coarse LocalApiErrorCode family (errors.<LOCAL_CODE>),
//    via ApiError.localCode, a wire code through
//    WIRE_TO_LOCAL_CODE, or a localCode field (SqlDbClientError).
// 3. Legacy message prefixes: WIKI_* maps to the existing
//    wiki.errors.* keys; a leading local code maps to its family.
// 4. errors.unknown for everything else.

import {
  ApiError,
  isApiErrorCode,
  WIRE_TO_LOCAL_CODE,
  type LocalApiErrorCode,
} from "./errors";

/** Wire codes with dedicated, actionable user text. */
const SPECIFIC_WIRE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  unauthenticated: "errors.unauthenticated",
  tag_name_taken: "errors.tag_name_taken",
  tag_locked: "errors.tag_locked",
  tag_in_use: "errors.tag_in_use",
  revision_conflict: "errors.revision_conflict",
});

const LOCAL_CODES: ReadonlySet<string> = new Set<LocalApiErrorCode>([
  "CAPABILITY_UNAVAILABLE",
  "CAPABILITY_GATED",
  "FEATURE_NOT_YET_AVAILABLE",
  "UNKNOWN_COMMAND",
  "VALIDATION_ERROR",
  "AUTH_REQUIRED",
  "NETWORK_ERROR",
  "TIMEOUT",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "SERVER_ERROR",
]);

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

function stringProp(error: unknown, key: string): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function messageText(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return stringProp(error, "message");
}

/**
 * Map an unknown thrown value to an i18n key for user display.
 * Returns null for AbortError (silent by design). The result is
 * always a key, never raw error text.
 */
export function userErrorMessageKey(error: unknown): string | null {
  if (isAbortError(error)) {
    return null;
  }
  if (error instanceof ApiError) {
    if (error.wireCode !== null && error.wireCode in SPECIFIC_WIRE_KEYS) {
      return SPECIFIC_WIRE_KEYS[error.wireCode];
    }
    return `errors.${error.localCode}`;
  }
  const code = stringProp(error, "code") ?? stringProp(error, "wireCode");
  if (code !== null) {
    if (code in SPECIFIC_WIRE_KEYS) {
      return SPECIFIC_WIRE_KEYS[code];
    }
    if (isApiErrorCode(code)) {
      return `errors.${WIRE_TO_LOCAL_CODE[code]}`;
    }
  }
  const localCode = stringProp(error, "localCode");
  if (localCode !== null && LOCAL_CODES.has(localCode)) {
    return `errors.${localCode}`;
  }
  const message = messageText(error);
  if (message !== null) {
    const wiki = /^(WIKI_[A-Z0-9_]+)/.exec(message);
    if (wiki) {
      return `wiki.errors.${wiki[1]}`;
    }
    const local = /^([A-Z][A-Z0-9_]+)/.exec(message);
    if (local && LOCAL_CODES.has(local[1])) {
      return `errors.${local[1]}`;
    }
  }
  return "errors.unknown";
}
