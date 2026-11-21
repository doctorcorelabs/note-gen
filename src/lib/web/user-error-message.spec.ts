// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the shared user error formatter
 * (user-error-message.ts), node:test convention like
 * errors.spec.ts. Run through an esbuild bundle:
 *
 *   ./node_modules/.bin/esbuild src/lib/web/user-error-message.spec.ts \
 *     --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert \
 *     --outfile=<staging-dir>/user-error-message.spec.mjs
 *   node --test <staging-dir>/user-error-message.spec.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "./errors";
import { userErrorMessageKey } from "./user-error-message";

describe("userErrorMessageKey", () => {
  it("maps specific wire codes to their dedicated keys", () => {
    const error = new ApiError({
      localCode: "CONFLICT",
      wireCode: "tag_name_taken",
      status: 409,
    });
    assert.equal(userErrorMessageKey(error), "errors.tag_name_taken");
  });

  it("maps tag_in_use so the TAG-01 dead end is actionable", () => {
    const error = new ApiError({
      localCode: "CONFLICT",
      wireCode: "tag_in_use",
      status: 409,
    });
    assert.equal(userErrorMessageKey(error), "errors.tag_in_use");
  });

  it("falls back to the local code family for other wire codes", () => {
    const error = new ApiError({
      localCode: "SERVER_ERROR",
      wireCode: "internal_error",
      status: 500,
    });
    assert.equal(userErrorMessageKey(error), "errors.SERVER_ERROR");
  });

  it("maps SqlDbClientError-shaped objects by wire code", () => {
    const error = {
      name: "SqlDbClientError",
      code: "payload_too_large",
      wireCode: "payload_too_large",
      localCode: "PAYLOAD_TOO_LARGE",
      status: 413,
      message: "Database request failed payload_too_large (HTTP 413, PAYLOAD_TOO_LARGE)",
    };
    assert.equal(userErrorMessageKey(error), "errors.PAYLOAD_TOO_LARGE");
  });

  it("never leaks a plain Error message (export asset case)", () => {
    const error = new Error("Unable to load export asset: https://example.invalid/x.png");
    const key = userErrorMessageKey(error);
    assert.equal(key, "errors.unknown");
    assert.ok(!key.includes("Unable"));
  });

  it("returns null for AbortError (silent cancel)", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    assert.equal(userErrorMessageKey(error), null);
  });

  it("maps WIKI_ message prefixes to the wiki namespace", () => {
    assert.equal(
      userErrorMessageKey(new Error("WIKI_NOT_FOUND: page missing")),
      "wiki.errors.WIKI_NOT_FOUND",
    );
  });

  it("maps leading local codes in legacy messages", () => {
    assert.equal(
      userErrorMessageKey(new Error("NETWORK_ERROR: fetch failed")),
      "errors.NETWORK_ERROR",
    );
  });

  it("handles non-Error values without leaking them", () => {
    assert.equal(userErrorMessageKey("some raw string"), "errors.unknown");
    assert.equal(userErrorMessageKey(null), "errors.unknown");
    assert.equal(userErrorMessageKey({}), "errors.unknown");
    assert.equal(userErrorMessageKey(undefined), "errors.unknown");
  });
});
