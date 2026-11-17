// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Runtime guard for a username read from a git hosting API response
 * (F122-Q1, W4-F122Q).
 *
 * The response body arrives through response.json() without runtime
 * validation, while the declared types (GiteaUserInfo, GitlabUserInfo,
 * UserInfo) state login/username as a required string. A malformed body
 * without that field used to reach store.set() as undefined: under the
 * interim store semantics the key was deleted silently, and under H3
 * (AD-106) set() throws invalid_argument, which misreports an API
 * validation failure as a store error. The guard throws a plain API
 * validation error before any store write, so the caller's existing
 * error handling (return false, toast plus rethrow, or the image
 * hosting check catch) sees the real cause and the stored username is
 * left unchanged.
 *
 * The check mirrors the Gitee precedent in gitee.ts, which already
 * validates `typeof data?.login === 'string'` with a non-empty value
 * before writing giteeUsername, including the message shape
 * "Invalid <provider> user response". An empty string is rejected like
 * a missing field: every reader treats a falsy stored username as
 * "not configured", so persisting "" could only masquerade as a
 * configured username in the store while behaving as unconfigured
 * everywhere else.
 */
export type ApiUsernameProvider = "GitHub" | "Gitea" | "Gitlab";

export function requireApiUsername(
  value: unknown,
  provider: ApiUsernameProvider,
): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Invalid ${provider} user response`);
  }
  return value;
}
