// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Collector Exa specs (F2-2, wave G-F2-2c). All HTTP runs against
// recorded-shape fixtures through the injected fetch: no real
// network call and no real Exa key happens in this suite. The
// first real Exa call is a separate gate after landing, with the
// key installed by Daivan in server env.

import { describe, expect, it } from 'vitest';
import { CollectorError } from '../src/services/deep-search/collector-pubmed.js';
import {
  createExaCollector,
  type ExaCollectorDeps,
} from '../src/services/deep-search/collector-exa.js';
import type { SearchJobRow } from '../src/services/deep-search/represent.js';
import { parseCreateJobBody } from '../src/services/deep-search/validation.js';

const TEST_KEY = 'exa-test-key-not-a-real-credential';

const EXA_FIXTURE = {
  results: [
    {
      id: 'https://example.org/guidelines/hypospadias-2024',
      title: 'Hypospadias guideline update 2024',
      url: 'https://example.org/guidelines/hypospadias-2024',
      publishedDate: '2024-03-01T00:00:00.000Z',
      author: 'Guideline Panel',
      highlights: ['First highlight sentence.', 'Second highlight sentence.'],
      score: 0.91,
    },
    {
      id: 'https://doi.org/10.1016/j.jpurol.2024.01.001',
      title: 'Surgical techniques for hypospadias',
      url: 'https://doi.org/10.1016/j.jpurol.2024.01.001',
      publishedDate: '2024-01-15T00:00:00.000Z',
      author: 'Roe K',
      highlights: ['Technique highlight.'],
      score: 0.88,
    },
    {
      id: 'https://example.org/no-url-entry',
      title: 'Entry without url is skipped',
      highlights: ['ignored'],
    },
  ],
  costDollars: { total: 0.005 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

interface FetchCall {
  url: string;
  at: number;
  body: Record<string, unknown>;
  apiKey: string | null;
}

function fixtureFetch(
  calls: FetchCall[],
  clock: { t: number },
  responder: (callIndex: number, body: Record<string, unknown>) => Response = () =>
    jsonResponse(EXA_FIXTURE),
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    calls.push({ url, at: clock.t, body, apiKey: headers['x-api-key'] ?? null });
    if (!url.includes('api.exa.ai')) {
      throw new Error(`Unexpected fetch URL in spec: ${url}`);
    }
    return responder(calls.length - 1, body);
  }) as typeof fetch;
}

function makeJob(body: Record<string, unknown> = {}): SearchJobRow {
  const input = parseCreateJobBody({
    projectKey: 'deck-x',
    topic: 'hypospadias guidelines',
    budgetExaUsd: 0.15,
    ...body,
  });
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    projectKey: input.projectKey,
    topic: input.topic,
    status: 'collecting',
    input: input.input,
    budgetExaUsd: input.budgetExaUsd ?? null,
    costExaUsd: '0',
    createdByUserId: null,
    createdByTokenId: null,
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    finishedAt: null,
    errorCode: null,
    errorDetail: null,
  };
}

function makeDeps(
  calls: FetchCall[],
  clock: { t: number },
  responder?: (callIndex: number, body: Record<string, unknown>) => Response,
  extra: Partial<ExaCollectorDeps> = {},
): ExaCollectorDeps {
  return {
    fetchFn: fixtureFetch(calls, clock, responder),
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    ...extra,
  };
}

describe('collector exa (fixtures)', () => {
  it('fails closed before any call when the API key is missing', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createExaCollector(undefined, makeDeps(calls, clock));
    await expect(collector.collect(makeJob(), 100)).rejects.toMatchObject({
      code: 'exa_key_missing',
    });
    await expect(collector.collect(makeJob(), 100)).rejects.toBeInstanceOf(CollectorError);
    expect(calls).toHaveLength(0);
  });

  it('fails closed before any call when the job has no Exa budget', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createExaCollector(TEST_KEY, makeDeps(calls, clock));
    const job = makeJob({ budgetExaUsd: undefined });
    expect(job.budgetExaUsd).toBeNull();
    await expect(collector.collect(job, 100)).rejects.toMatchObject({
      code: 'exa_budget_missing',
    });
    expect(calls).toHaveLength(0);
  });

  it('normalizes hits, derives DOI identity, and records reported cost', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createExaCollector(TEST_KEY, makeDeps(calls, clock));
    const result = await collector.collect(makeJob(), 100);

    expect(result.outcome).toMatchObject({ ok: true, resultCount: 2 });
    expect(result.calls).toBe(1);
    expect(result.costUsd).toBe('0.0050');
    expect(result.candidates.map((c) => c.externalId)).toEqual([
      'https://example.org/guidelines/hypospadias-2024',
      'doi:10.1016/j.jpurol.2024.01.001',
    ]);
    const first = result.candidates[0];
    expect(first?.sourceKind).toBe('exa');
    expect(first?.authors).toBe('Guideline Panel');
    expect(first?.year).toBe(2024);
    expect(first?.snippet).toBe('First highlight sentence. Second highlight sentence.');
    const second = result.candidates[1];
    expect(second?.doi).toBe('10.1016/j.jpurol.2024.01.001');
    expect(second?.pmid).toBeNull();

    expect(result.queryEvidence).toHaveLength(1);
    expect(result.queryEvidence[0]?.sourceKind).toBe('exa');
    expect(result.queryEvidence[0]?.note).toContain('cost=0.0050');
    expect(result.candidateEvidence).toHaveLength(2);

    // The key rides only in the request header, never in evidence.
    expect(calls[0]?.apiKey).toBe(TEST_KEY);
    const evidenceText = JSON.stringify(result.queryEvidence) + JSON.stringify(result.candidateEvidence);
    expect(evidenceText).not.toContain(TEST_KEY);
    // Highlights only, never full text contents.
    expect(JSON.stringify(calls[0]?.body)).toContain('highlights');
    expect(JSON.stringify(calls[0]?.body)).not.toContain('"text"');
  });

  it('stops on 429 with no retry and no recorded cost', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createExaCollector(
      TEST_KEY,
      makeDeps(calls, clock, () => jsonResponse({}, 429)),
    );
    const result = await collector.collect(makeJob(), 100);
    expect(result.outcome).toMatchObject({
      ok: false,
      httpStatus: 429,
      errorCode: 'rate_limited',
    });
    expect(result.calls).toBe(1);
    expect(result.costUsd).toBe('0.0000');
    expect(result.candidates).toHaveLength(0);
    expect(result.queryEvidence[0]?.note).toContain('failed=rate_limited');
  });

  it('records an HTTP error as a failed outcome', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createExaCollector(
      TEST_KEY,
      makeDeps(calls, clock, () => jsonResponse({}, 503)),
    );
    const result = await collector.collect(makeJob(), 100);
    expect(result.outcome).toMatchObject({ ok: false, httpStatus: 503, errorCode: 'http_error' });
    expect(result.costUsd).toBe('0.0000');
  });

  it('never issues a call whose estimate would exceed the job ceiling', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    // Budget 0.0050 with a 0.0050 estimate: exactly one call fits.
    // The fixture returns the same two results every time, so the
    // second call would add nothing; the guard must stop first.
    const collector = createExaCollector(TEST_KEY, makeDeps(calls, clock));
    const result = await collector.collect(makeJob({ budgetExaUsd: 0.005 }), 100);
    expect(result.calls).toBe(1);
    expect(result.costUsd).toBe('0.0050');
    expect(calls).toHaveLength(1);
  });

  it('stops at the per-job call ceiling even with budget to spare', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    // Every call returns exactly the requested count, but all
    // entries duplicate one fresh URL per call, so neither the
    // candidate cap (5) nor source exhaustion can stop the
    // stage; only the call ceiling (2 here) does.
    const responder = (callIndex: number, body: Record<string, unknown>): Response => {
      const requested = typeof body['numResults'] === 'number' ? body['numResults'] : 1;
      return jsonResponse({
        results: Array.from({ length: requested }, () => ({
          title: `Result ${callIndex}`,
          url: `https://example.org/r${callIndex}`,
          highlights: ['h'],
        })),
        costDollars: { total: 0.005 },
      });
    };
    const collector = createExaCollector(
      TEST_KEY,
      makeDeps(calls, clock, responder, { maxCallsPerJob: 2 }),
    );
    const result = await collector.collect(makeJob(), 5);
    expect(result.calls).toBe(2);
    expect(result.costUsd).toBe('0.0100');
    expect(result.candidates).toHaveLength(2);
  });

  it('honors the candidate cap and builds year-bounded requests', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createExaCollector(TEST_KEY, makeDeps(calls, clock));
    const job = makeJob({ yearFrom: 2020, yearTo: 2025 });
    const result = await collector.collect(job, 1);
    expect(result.candidates).toHaveLength(1);
    expect(calls[0]?.body['numResults']).toBe(1);
    expect(calls[0]?.body['startPublishedDate']).toBe('2020-01-01T00:00:00.000Z');
    expect(calls[0]?.body['endPublishedDate']).toBe('2025-12-31T23:59:59.999Z');
  });
});
