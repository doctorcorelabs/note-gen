// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-17): custom-header row conversion with stable,
// deterministic ids so re-parsing never remounts inputs.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { describe, expect, it } from "vitest";

import { convertKeyValueToJson, parseHeadersToKeyValue } from "./header-pairs";

describe("SET-17 header pairs", () => {
  it("round-trips keyed pairs through parse and convert", () => {
    const headers = { Authorization: "Bearer x", "X-Trace": "1" };
    expect(convertKeyValueToJson(parseHeadersToKeyValue(headers))).toEqual(headers);
  });

  it("drops pairs with an empty key from the stored JSON", () => {
    expect(convertKeyValueToJson([
      { key: "", value: "orphan" },
      { key: "X-A", value: "1" },
    ])).toEqual({ "X-A": "1" });
  });

  it("produces identical ids when parsing the same headers twice", () => {
    const headers = { A: "1", B: "2" };
    const first = parseHeadersToKeyValue(headers).map(pair => pair.id);
    const second = parseHeadersToKeyValue(headers).map(pair => pair.id);
    expect(second).toEqual(first);
  });

  it("coerces non-string values to strings", () => {
    const pairs = parseHeadersToKeyValue({ N: 42 } as unknown as Record<string, string>);
    expect(pairs).toEqual([{ key: "N", value: "42", id: "header-0" }]);
  });
});
