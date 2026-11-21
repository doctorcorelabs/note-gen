// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-10): a user-set temperature/topP of 0 must reach
// the provider unchanged; only unset values fall back to 1.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { describe, expect, it } from "vitest";

import { resolveSamplingParams } from "./sampling-params";

describe("SET-10 resolveSamplingParams", () => {
  it("forwards temperature 0 and topP 0 unchanged", () => {
    expect(resolveSamplingParams({ temperature: 0, topP: 0 })).toEqual({
      temperature: 0,
      top_p: 0,
    });
  });

  it("falls back to 1 only when values are unset", () => {
    expect(resolveSamplingParams(undefined)).toEqual({ temperature: 1, top_p: 1 });
    expect(resolveSamplingParams({})).toEqual({ temperature: 1, top_p: 1 });
  });

  it("keeps normal values unchanged", () => {
    expect(resolveSamplingParams({ temperature: 0.7, topP: 0.9 })).toEqual({
      temperature: 0.7,
      top_p: 0.9,
    });
  });
});
