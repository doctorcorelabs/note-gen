// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Collector PubMed specs (F2-2, wave G-F2-2b). All HTTP runs
// against recorded-shape fixtures through the injected fetch: no
// real network call happens in this suite. The first real
// Europe PMC / E-utilities call is a separate gate after landing.

import { describe, expect, it } from 'vitest';
import {
  CollectorError,
  createPubmedCollector,
  type PubmedCollectorDeps,
} from '../src/services/deep-search/collector-pubmed.js';
import type { SearchJobRow } from '../src/services/deep-search/represent.js';
import { parseCreateJobBody } from '../src/services/deep-search/validation.js';

const IDENTITY = { tool: 'notegen', email: 'collector-test@example.org' };

const EUROPEPMC_FIXTURE = {
  resultList: {
    result: [
      {
        id: '40118740',
        source: 'MED',
        pmid: '40118740',
        pmcid: 'PMC1234567',
        doi: '10.1016/j.eururo.2025.02.022',
        title: 'Guidelines on Paediatric Urology Part II',
        authorString: 'Skott M, Kennedy U.',
        journalInfo: { journal: { title: 'European Urology' }, yearOfPublication: 2025 },
        pubYear: '2025',
        isOpenAccess: 'Y',
        abstractText: 'Background and objective: summary of 2024 updates.',
      },
      {
        id: 'PMC9995849',
        source: 'PMC',
        pmcid: 'PMC9995849',
        title: 'Hypospadias: a comprehensive review',
        authorString: 'Doe J.',
        pubYear: '2023',
        isOpenAccess: 'N',
      },
    ],
  },
};

const ESEARCH_FIXTURE = {
  esearchresult: { idlist: ['40118740', '38765432'] },
};

const ESUMMARY_FIXTURE = {
  result: {
    uids: ['40118740', '38765432'],
    '40118740': {
      uid: '40118740',
      title: 'Guidelines on Paediatric Urology Part II',
      fulljournalname: 'European urology',
      pubdate: '2025 Jun',
      authors: [{ name: 'Skott M' }],
      articleids: [
        { idtype: 'pubmed', value: '40118740' },
        { idtype: 'doi', value: '10.1016/j.eururo.2025.02.022' },
      ],
    },
    '38765432': {
      uid: '38765432',
      title: 'Surgical techniques for hypospadias',
      fulljournalname: 'Journal of Pediatric Urology',
      pubdate: '2024 Jan',
      authors: [{ name: 'Roe K' }, { name: 'Poe L' }],
      articleids: [
        { idtype: 'pubmed', value: '38765432' },
        { idtype: 'doi', value: '10.1016/j.jpurol.2024.01.001' },
        { idtype: 'pmc', value: 'PMC7654321' },
      ],
    },
  },
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
}

function fixtureFetch(
  calls: FetchCall[],
  clock: { t: number },
  overrides: {
    europepmc?: () => Response;
    esearch?: () => Response;
    esummary?: () => Response;
  } = {},
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push({ url, at: clock.t });
    if (url.includes('europepmc')) {
      return overrides.europepmc?.() ?? jsonResponse(EUROPEPMC_FIXTURE);
    }
    if (url.includes('esearch')) {
      return overrides.esearch?.() ?? jsonResponse(ESEARCH_FIXTURE);
    }
    if (url.includes('esummary')) {
      return overrides.esummary?.() ?? jsonResponse(ESUMMARY_FIXTURE);
    }
    throw new Error(`Unexpected fetch URL in spec: ${url}`);
  }) as typeof fetch;
}

function makeJob(body: Record<string, unknown> = {}): SearchJobRow {
  const input = parseCreateJobBody({ projectKey: 'deck-x', topic: 'hypospadias', ...body });
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    projectKey: input.projectKey,
    topic: input.topic,
    status: 'collecting',
    input: input.input,
    budgetExaUsd: null,
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
  overrides?: Parameters<typeof fixtureFetch>[2],
): PubmedCollectorDeps {
  return {
    fetchFn: fixtureFetch(calls, clock, overrides),
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
  };
}

describe('collector pubmed (fixtures)', () => {
  it('fails closed before any call when the E-utilities email is missing', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createPubmedCollector(
      { tool: 'notegen', email: undefined },
      makeDeps(calls, clock),
    );
    await expect(collector.collect(makeJob(), 100)).rejects.toMatchObject({
      code: 'eutils_identity_missing',
    });
    await expect(collector.collect(makeJob(), 100)).rejects.toBeInstanceOf(CollectorError);
    expect(calls).toHaveLength(0);
  });

  it('merges Europe PMC and PubMed hits by external id with full evidence', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createPubmedCollector(IDENTITY, makeDeps(calls, clock));
    const result = await collector.collect(makeJob(), 100);

    expect(result.sources.europepmc).toMatchObject({ ok: true, resultCount: 2 });
    expect(result.sources.pubmed).toMatchObject({ ok: true, resultCount: 2 });
    expect(result.candidates.map((c) => c.externalId)).toEqual([
      'pmid:40118740',
      'pmcid:PMC9995849',
      'pmid:38765432',
    ]);

    const merged = result.candidates[0];
    expect(merged?.sourceKind).toBe('europepmc');
    expect(merged?.oaFlag).toBe(true);
    expect(merged?.snippet).toContain('Background and objective');
    expect(merged?.url).toBe('https://pubmed.ncbi.nlm.nih.gov/40118740/');

    const pubmedOnly = result.candidates[2];
    expect(pubmedOnly?.sourceKind).toBe('pubmed');
    expect(pubmedOnly?.pmcid).toBe('PMC7654321');
    expect(pubmedOnly?.authors).toBe('Roe K, Poe L');
    expect(pubmedOnly?.year).toBe(2024);

    expect(result.queryEvidence).toHaveLength(2);
    expect(result.queryEvidence.map((e) => e.sourceKind)).toEqual(['europepmc', 'pubmed']);
    expect(result.candidateEvidence).toHaveLength(3);

    const eutilsCalls = calls.filter((c) => c.url.includes('eutils'));
    expect(eutilsCalls.length).toBeGreaterThan(0);
    for (const call of eutilsCalls) {
      expect(call.url).toContain('tool=notegen');
      expect(call.url).toContain('email=collector-test%40example.org');
    }
  });

  it('throttles external requests to one per 0.4 seconds', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createPubmedCollector(IDENTITY, makeDeps(calls, clock));
    await collector.collect(makeJob(), 100);
    expect(calls.length).toBe(3);
    for (let i = 1; i < calls.length; i += 1) {
      expect((calls[i]?.at ?? 0) - (calls[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(400);
    }
  });

  it('records a PubMed 429 as a failed source and never calls esummary', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createPubmedCollector(
      IDENTITY,
      makeDeps(calls, clock, { esearch: () => jsonResponse({}, 429) }),
    );
    const result = await collector.collect(makeJob(), 100);
    expect(result.sources.pubmed).toMatchObject({
      ok: false,
      httpStatus: 429,
      errorCode: 'rate_limited',
    });
    expect(result.sources.europepmc.ok).toBe(true);
    expect(result.candidates.map((c) => c.sourceKind)).toEqual(['europepmc', 'europepmc']);
    expect(calls.some((c) => c.url.includes('esummary'))).toBe(false);
  });

  it('records a Europe PMC failure while PubMed still succeeds', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createPubmedCollector(
      IDENTITY,
      makeDeps(calls, clock, { europepmc: () => jsonResponse({}, 503) }),
    );
    const result = await collector.collect(makeJob(), 100);
    expect(result.sources.europepmc).toMatchObject({
      ok: false,
      httpStatus: 503,
      errorCode: 'http_error',
    });
    expect(result.sources.pubmed.ok).toBe(true);
    expect(result.candidates.map((c) => c.externalId)).toEqual([
      'pmid:40118740',
      'pmid:38765432',
    ]);
  });

  it('honors the candidate cap and builds year/language queries', async () => {
    const calls: FetchCall[] = [];
    const clock = { t: 0 };
    const collector = createPubmedCollector(IDENTITY, makeDeps(calls, clock));
    const job = makeJob({ yearFrom: 2020, yearTo: 2025, language: 'eng' });
    const result = await collector.collect(job, 1);
    expect(result.candidates).toHaveLength(1);

    const europeCall = calls.find((c) => c.url.includes('europepmc'));
    expect(decodeURIComponent(europeCall?.url ?? '')).toContain('PUB_YEAR:[2020 TO 2025]');
    expect(decodeURIComponent(europeCall?.url ?? '')).toContain('LANG:"eng"');
    const esearchCall = calls.find((c) => c.url.includes('esearch'));
    expect(decodeURIComponent(esearchCall?.url ?? '')).toContain('2020:2025[dp]');
    expect(decodeURIComponent(esearchCall?.url ?? '')).toContain('eng[la]');
  });
});
