// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Vitest-style specs for the read-only citations client
// (citations-client.ts, F2-1 wave G-F2-1e) against an injected fake
// fetch through ApiClient. No test sends real HTTP.
//
// Coverage contract: the client only issues GET requests to the
// G-F2-1b citations and structured-record routes, never sends a
// workspace identifier, fails closed on malformed responses
// instead of rendering invented references or facts, and never
// assigns a marker to a fact absent from the citation map (the
// binding unmapped rule).
//
// Runs in the Vitest leg of `pnpm test:unit` and is listed in
// VITEST_SPECS in scripts/run-adapter-tests.mjs.

import { describe, expect, it } from "vitest";

import { ApiClient } from "./api-client";
import { ApiError } from "./errors";
import {
  factMarkerNumbers,
  getProjectCitationMap,
  getProjectFacts,
  getProjectReferences,
  getRecordBibliography,
  normalizeProjectKey,
  sortCitationReferences,
  type CitationReference,
} from "./citations-client";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function fakeResponse(status: number, body: string): Response {
  return {
    status,
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () =>
      new TextEncoder().encode(body).buffer as ArrayBuffer,
  } as unknown as Response;
}

function ok(data: unknown, status = 200): Response {
  return fakeResponse(status, JSON.stringify({ ok: true, data }));
}

function fail(status: number, code: string): Response {
  return fakeResponse(
    status,
    JSON.stringify({
      ok: false,
      error: {
        code,
        message: code,
        requestId: "req-test",
        retryable: false,
        details: {},
      },
    }),
  );
}

function makeClient(
  responder: (call: CapturedCall) => Response | Promise<Response>,
): { client: ApiClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const call: CapturedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { client: new ApiClient({ fetchFn }), calls };
}

function referenceData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    projectKey: "deck-hipospadia",
    number: 1,
    sourceRecordId: 42,
    title: "Hypospadias review",
    authors: "Skott et al.",
    journal: "EAU Guidelines",
    year: 2025,
    doi: "10.1000/example",
    pmid: "40118740",
    pmcid: null,
    url: "https://doi.org/10.1000/example",
    oaFlag: true,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function factData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    projectKey: "deck-hipospadia",
    text: "Hypospadias incidence is about 1 in 250 births.",
    score: 88,
    status: "mapped",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe("normalizeProjectKey", () => {
  it("trims and accepts a normal key", () => {
    expect(normalizeProjectKey("  deck-hipospadia  ")).toBe("deck-hipospadia");
  });

  it("rejects empty, whitespace, overlong, and non-string input", () => {
    expect(normalizeProjectKey("")).toBeNull();
    expect(normalizeProjectKey("   ")).toBeNull();
    expect(normalizeProjectKey("x".repeat(129))).toBeNull();
    expect(normalizeProjectKey(42)).toBeNull();
    expect(normalizeProjectKey(null)).toBeNull();
  });
});

describe("getProjectReferences", () => {
  it("issues one GET to the project references route with no workspace id", async () => {
    const { client, calls } = makeClient(() =>
      ok({ items: [referenceData()] }),
    );
    const rows = await getProjectReferences(client, "deck-hipospadia");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.number).toBe(1);
    expect(rows[0]?.pmid).toBe("40118740");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method ?? "GET").toBe("GET");
    expect(calls[0]?.url).toContain(
      "/api/citations/projects/deck-hipospadia/references",
    );
    expect(calls[0]?.url).not.toContain("workspace");
  });

  it("URL-encodes the project key", async () => {
    const { client, calls } = makeClient(() => ok({ items: [] }));
    await getProjectReferences(client, "Deck Hipospadia");
    expect(calls[0]?.url).toContain(
      "/api/citations/projects/Deck%20Hipospadia/references",
    );
  });

  it("rejects an invalid project key before any fetch", async () => {
    const { client, calls } = makeClient(() => ok({ items: [] }));
    await expect(getProjectReferences(client, "  ")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(calls).toHaveLength(0);
  });

  it("fails closed on a malformed reference row", async () => {
    const { client } = makeClient(() =>
      ok({ items: [referenceData({ number: "1" })] }),
    );
    await expect(
      getProjectReferences(client, "deck-hipospadia"),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("surfaces a wire 404 as an ApiError, never an empty list", async () => {
    const { client } = makeClient(() => fail(404, "not_found"));
    await expect(
      getProjectReferences(client, "deck-hipospadia"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("getProjectFacts", () => {
  it("returns mapped and unmapped facts with their status intact", async () => {
    const { client, calls } = makeClient(() =>
      ok({
        items: [
          factData(),
          factData({
            id: "44444444-4444-4444-8444-444444444444",
            status: "unmapped",
            score: 35,
          }),
        ],
      }),
    );
    const rows = await getProjectFacts(client, "deck-hipospadia");
    expect(rows.map((row) => row.status)).toEqual(["mapped", "unmapped"]);
    expect(calls[0]?.url).toContain(
      "/api/citations/projects/deck-hipospadia/facts",
    );
  });

  it("fails closed on an unknown fact status", async () => {
    const { client } = makeClient(() =>
      ok({ items: [factData({ status: "pending" })] }),
    );
    await expect(
      getProjectFacts(client, "deck-hipospadia"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("getProjectCitationMap and factMarkerNumbers", () => {
  it("returns markers for mapped facts and none for absent facts", async () => {
    const { client, calls } = makeClient(() =>
      ok({
        projectKey: "deck-hipospadia",
        entries: [
          { factId: "33333333-3333-4333-8333-333333333333", numbers: [1, 3] },
        ],
      }),
    );
    const entries = await getProjectCitationMap(client, "deck-hipospadia");
    expect(
      factMarkerNumbers(entries, "33333333-3333-4333-8333-333333333333"),
    ).toEqual([1, 3]);
    // Unmapped facts never appear in the map and get no marker.
    expect(
      factMarkerNumbers(entries, "44444444-4444-4444-8444-444444444444"),
    ).toEqual([]);
    expect(calls[0]?.url).toContain(
      "/api/citations/projects/deck-hipospadia/map",
    );
  });

  it("fails closed when entries is not an array", async () => {
    const { client } = makeClient(() =>
      ok({ projectKey: "deck-hipospadia", entries: {} }),
    );
    await expect(
      getProjectCitationMap(client, "deck-hipospadia"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("getRecordBibliography", () => {
  it("returns the bibliography of a structured record", async () => {
    const { client, calls } = makeClient(() =>
      ok({
        record: { id: 42 },
        bibliography: {
          markId: 42,
          workspaceId: "22222222-2222-4222-8222-222222222222",
          title: "Hypospadias review",
          authors: "Skott et al.",
          journal: "EAU Guidelines",
          year: 2025,
          doi: "10.1000/example",
          pmid: "40118740",
          pmcid: null,
          url: null,
          oaFlag: null,
          createdAt: 1000,
          updatedAt: 2000,
        },
      }),
    );
    const bib = await getRecordBibliography(client, 42);
    expect(bib?.pmid).toBe("40118740");
    expect(calls[0]?.url).toContain("/api/records/structured/42");
  });

  it("returns null when the record has no bibliography row", async () => {
    const { client } = makeClient(() =>
      ok({ record: { id: 7 }, bibliography: null }),
    );
    await expect(getRecordBibliography(client, 7)).resolves.toBeNull();
  });

  it("rejects a non-positive mark id before any fetch", async () => {
    const { client, calls } = makeClient(() =>
      ok({ record: { id: 0 }, bibliography: null }),
    );
    await expect(getRecordBibliography(client, 0)).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("sortCitationReferences", () => {
  it("orders numbered first ascending, then unnumbered by creation", () => {
    const base = referenceData() as unknown as CitationReference;
    const rows: CitationReference[] = [
      { ...base, id: "c", number: null, createdAt: 3000 },
      { ...base, id: "a", number: 2, createdAt: 1000 },
      { ...base, id: "b", number: 1, createdAt: 2000 },
      { ...base, id: "d", number: null, createdAt: 500 },
    ];
    expect(sortCitationReferences(rows).map((row) => row.id)).toEqual([
      "b",
      "a",
      "d",
      "c",
    ]);
    // Input order is not mutated.
    expect(rows.map((row) => row.id)).toEqual(["c", "a", "b", "d"]);
  });
});
