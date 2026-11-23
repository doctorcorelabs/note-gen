// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Vitest-style specs for the Deep Search client
// (deep-search-client.ts, F2-2 wave G-F2-2f) against an injected
// fake fetch through ApiClient. No test sends real HTTP.
//
// Coverage contract: the client only calls the G-F2-2a..e
// cookie-auth Deep Search routes, never sends a workspace
// identifier or a credential field, never sends writingApproved
// in the create body (approval is its own call, decision 8),
// validates create input against the server bounds locally, and
// fails closed on malformed responses instead of rendering
// invented jobs, candidates, or scores.
//
// Runs in the Vitest leg of `pnpm test:unit` and is listed in
// VITEST_SPECS in scripts/run-adapter-tests.mjs.

import { describe, expect, it } from "vitest";

import { ApiClient } from "./api-client";
import { ApiError } from "./errors";
import {
  approveDeepSearchWriting,
  buildCreateJobBody,
  cancelDeepSearchJob,
  createDeepSearchJob,
  getDeepSearchJob,
  isDeepSearchJobActive,
  listDeepSearchCandidates,
  listDeepSearchFactCandidates,
  listDeepSearchJobs,
  normalizeDeepSearchProjectKey,
  retryDeepSearchJob,
} from "./deep-search-client";

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

const JOB_ID = "55555555-5555-4555-8555-555555555555";

function jobData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    projectKey: "deck-hipospadia",
    topic: "hypospadias repair",
    status: "queued",
    input: {
      maxCandidates: 100,
      yearFrom: null,
      yearTo: null,
      language: null,
      stages: "full",
      complementThresholdFact: 70,
      complementThresholdAverage: 80,
      writingApproved: false,
    },
    budgetExaUsd: null,
    costExaUsd: "0",
    createdByUserId: "33333333-3333-4333-8333-333333333333",
    createdByTokenId: null,
    createdAt: 1000,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorDetail: null,
    ...overrides,
  };
}

function candidateData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    jobId: JOB_ID,
    sourceKind: "pubmed",
    externalId: "pmid:40118740",
    title: "EAU/ESPU Paediatric Urology Part II",
    authors: "Skott et al.",
    journal: "Eur Urol",
    year: 2025,
    doi: "10.1016/j.eururo.2025.02.022",
    pmid: "40118740",
    pmcid: null,
    url: "https://pubmed.ncbi.nlm.nih.gov/40118740/",
    oaFlag: false,
    snippet: "Guideline summary.",
    disposition: "accepted",
    rejectReason: null,
    recordMarkId: null,
    createdAt: 1000,
    ...overrides,
  };
}

function factData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    jobId: JOB_ID,
    text: "Hypospadias incidence is about 1 in 250 births.",
    score: 88,
    status: "mapped",
    factId: null,
    assessorNote: null,
    createdAt: 1000,
    ...overrides,
  };
}

describe("normalizeDeepSearchProjectKey", () => {
  it("trims and accepts a normal key", () => {
    expect(normalizeDeepSearchProjectKey("  deck-hipospadia  ")).toBe("deck-hipospadia");
  });

  it("rejects empty, whitespace, overlong, and non-string input", () => {
    expect(normalizeDeepSearchProjectKey("")).toBeNull();
    expect(normalizeDeepSearchProjectKey("   ")).toBeNull();
    expect(normalizeDeepSearchProjectKey("x".repeat(129))).toBeNull();
    expect(normalizeDeepSearchProjectKey(42)).toBeNull();
  });
});

describe("buildCreateJobBody", () => {
  it("builds the minimal body and omits absent optionals", () => {
    expect(buildCreateJobBody({ projectKey: "deck-hipospadia", topic: "repair" })).toEqual({
      projectKey: "deck-hipospadia",
      topic: "repair",
    });
  });

  it("never includes writingApproved or a credential field", () => {
    const body = buildCreateJobBody({
      projectKey: "deck-hipospadia",
      topic: "repair",
      budgetExaUsd: 0.15,
      maxCandidates: 50,
      yearFrom: 2020,
      yearTo: 2026,
      language: "en",
      stages: "full",
    });
    expect(body).not.toBeNull();
    expect(Object.keys(body ?? {}).sort()).toEqual(
      ["budgetExaUsd", "language", "maxCandidates", "projectKey", "stages", "topic", "yearFrom", "yearTo"].sort(),
    );
  });

  it("rejects out-of-bound values", () => {
    const base = { projectKey: "deck-hipospadia", topic: "repair" };
    expect(buildCreateJobBody({ ...base, budgetExaUsd: 0.16 })).toBeNull();
    expect(buildCreateJobBody({ ...base, budgetExaUsd: 0 })).toBeNull();
    expect(buildCreateJobBody({ ...base, maxCandidates: 101 })).toBeNull();
    expect(buildCreateJobBody({ ...base, maxCandidates: 0 })).toBeNull();
    expect(buildCreateJobBody({ ...base, yearFrom: 2026, yearTo: 2020 })).toBeNull();
    expect(buildCreateJobBody({ projectKey: "", topic: "repair" })).toBeNull();
    expect(buildCreateJobBody({ projectKey: "deck-hipospadia", topic: "  " })).toBeNull();
  });
});

describe("createDeepSearchJob", () => {
  it("posts to the jobs route and parses the queued job", async () => {
    const { client, calls } = makeClient(() => ok(jobData(), 202));
    const job = await createDeepSearchJob(client, {
      projectKey: "deck-hipospadia",
      topic: "hypospadias repair",
    });
    expect(job.id).toBe(JOB_ID);
    expect(job.status).toBe("queued");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/deep-search/jobs");
    expect(calls[0]?.init.method).toBe("POST");
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent).toEqual({ projectKey: "deck-hipospadia", topic: "hypospadias repair" });
  });

  it("fails locally on invalid input without any request", async () => {
    const { client, calls } = makeClient(() => ok(jobData(), 202));
    await expect(
      createDeepSearchJob(client, { projectKey: "", topic: "repair" }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });

  it("fails closed on a malformed job response", async () => {
    const { client } = makeClient(() => ok(jobData({ status: "invented" }), 202));
    await expect(
      createDeepSearchJob(client, { projectKey: "deck-hipospadia", topic: "repair" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("reads", () => {
  it("lists jobs with the project filter in the query", async () => {
    const { client, calls } = makeClient(() =>
      ok({ items: [jobData()], nextCursor: null }),
    );
    const jobs = await listDeepSearchJobs(client, { projectKey: "deck-hipospadia" });
    expect(jobs).toHaveLength(1);
    expect(calls[0]?.url).toContain("projectKey=deck-hipospadia");
    expect(calls[0]?.url).not.toContain("workspaceId");
  });

  it("parses job detail with steps and summary", async () => {
    const { client } = makeClient(() =>
      ok({
        job: jobData({ status: "collecting" }),
        steps: [
          {
            id: "88888888-8888-4888-8888-888888888888",
            jobId: JOB_ID,
            step: "collector_pubmed",
            status: "running",
            detail: null,
            startedAt: 1000,
            finishedAt: null,
          },
        ],
        summary: {
          candidates: 3,
          acceptedCandidates: 2,
          factCandidates: 0,
          mappedFacts: 0,
          unmappedFacts: 0,
        },
      }),
    );
    const detail = await getDeepSearchJob(client, JOB_ID);
    expect(detail.job.status).toBe("collecting");
    expect(detail.steps).toHaveLength(1);
    expect(detail.summary.candidates).toBe(3);
    expect(isDeepSearchJobActive(detail.job)).toBe(true);
  });

  it("parses candidates and fact candidates", async () => {
    const { client } = makeClient((call) =>
      call.url.includes("/candidates")
        ? ok({ items: [candidateData()] })
        : ok({ items: [factData()] }),
    );
    const candidates = await listDeepSearchCandidates(client, JOB_ID);
    expect(candidates[0]?.pmid).toBe("40118740");
    const facts = await listDeepSearchFactCandidates(client, JOB_ID);
    expect(facts[0]?.score).toBe(88);
    expect(facts[0]?.status).toBe("mapped");
  });

  it("fails closed on an unknown fact status", async () => {
    const { client } = makeClient(() => ok({ items: [factData({ status: "guessed" })] }));
    await expect(listDeepSearchFactCandidates(client, JOB_ID)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe("mutations", () => {
  it("posts cancel, retry, and approve-writing to their own routes", async () => {
    const { client, calls } = makeClient(() => ok(jobData({ status: "cancelled" })));
    await cancelDeepSearchJob(client, JOB_ID);
    await retryDeepSearchJob(client, JOB_ID);
    await approveDeepSearchWriting(client, JOB_ID);
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining(`/api/deep-search/jobs/${JOB_ID}/cancel`),
      expect.stringContaining(`/api/deep-search/jobs/${JOB_ID}/retry`),
      expect.stringContaining(`/api/deep-search/jobs/${JOB_ID}/approve-writing`),
    ]);
    for (const call of calls) {
      expect(call.init.method).toBe("POST");
    }
  });

  it("rejects an empty job id locally", async () => {
    const { client, calls } = makeClient(() => ok(jobData()));
    await expect(cancelDeepSearchJob(client, "  ")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });
});
