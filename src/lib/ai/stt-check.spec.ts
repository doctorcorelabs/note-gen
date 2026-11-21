// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-08): only an audio-format rejection (HTTP 400)
// proves the STT connection check passed. Everything else is
// a failed check, including the web-mode 501 rejection.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { describe, expect, it } from "vitest";

import { isSttFormatRejection } from "./stt-check";

describe("SET-08 isSttFormatRejection", () => {
  it("treats a 400 format rejection as a passed check", () => {
    expect(isSttFormatRejection(new Error("HTTP 400: invalid file format"))).toBe(true);
  });

  it("fails auth, route, and server errors", () => {
    expect(isSttFormatRejection(new Error("401 Unauthorized"))).toBe(false);
    expect(isSttFormatRejection(new Error("403 Forbidden"))).toBe(false);
    expect(isSttFormatRejection(new Error("404 model not found"))).toBe(false);
    expect(isSttFormatRejection(new Error("500 Internal Server Error"))).toBe(false);
    expect(isSttFormatRejection(new Error("501 Not Implemented"))).toBe(false);
  });

  it("fails network errors without a status", () => {
    expect(isSttFormatRejection(new Error("fetch failed"))).toBe(false);
  });

  it("never treats an abort as a format rejection", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(isSttFormatRejection(abort)).toBe(false);
  });
});
