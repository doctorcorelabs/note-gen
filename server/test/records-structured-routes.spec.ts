// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Structured records routes over the in-memory fakes (F2-1 wave
// G-F2-1b): create derives the deterministic sourceId and the
// record url, identifier dedupe returns the first record, a
// conflicting retry answers 409 with the differing fields, GET
// returns record + bibliography, and PATCH corrects bibliography
// fields only (with a collision guard on DOI/PMID changes).

import Fastify, { LogController, type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultVerifyOrigin,
  readCsrfTokenHeader,
  registerAuthHooks,
  type SessionPrincipal,
  type VerifySessionFn,
} from '../src/middleware/auth-hook.js';
import { registerErrorHandling } from '../src/plugins/error-handler.js';
import { registerRequestId, requestIdFromHeaders } from '../src/plugins/request-id.js';
import { registerStructuredRecordsRoutes } from '../src/routes/records-structured.js';
import {
  createFakeCitationsRepository,
  type FakeCitationsRepository,
} from '../src/services/citations/fake-repository.js';
import {
  createFakeRecordsRepository,
  type FakeRecordsRepository,
} from '../src/services/records/fake-repository.js';
import {
  conflictingBibliographyFields,
  deriveRecordUrl,
  mergeBibliography,
  parseStructuredCreateBody,
} from '../src/services/records/structured.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TEST_PRINCIPAL: SessionPrincipal = { userId: 'user-1', role: 'user', sessionId: 'sess-1' };

interface Fixture {
  app: FastifyInstance;
  records: FakeRecordsRepository;
  citations: FakeCitationsRepository;
}

let fixture: Fixture | undefined;

const verifySession: VerifySessionFn = async ({ sessionId }) =>
  sessionId === 'good-session' ? TEST_PRINCIPAL : null;

async function setup(): Promise<Fixture> {
  const records = createFakeRecordsRepository(WORKSPACE_ID);
  const citations = createFakeCitationsRepository(WORKSPACE_ID);
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });
  registerRequestId(app);
  registerErrorHandling(app, { version: 'test' });
  registerAuthHooks(app, {
    verifySession,
    verifyCsrf: async (request) => readCsrfTokenHeader(request) === 'good-csrf',
    verifyOrigin: defaultVerifyOrigin,
    canonicalOrigin: TEST_ORIGIN,
  });
  await registerStructuredRecordsRoutes(app, {
    records,
    citations,
    resolveWorkspaceId: async () => WORKSPACE_ID,
  });
  await app.ready();
  fixture = { app, records, citations };
  return fixture;
}

beforeEach(() => {
  fixture = undefined;
});

afterEach(async () => {
  if (fixture !== undefined) {
    await fixture.app.close();
    fixture = undefined;
  }
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: 'notegen_session=good-session',
    origin: TEST_ORIGIN,
    'x-csrf-token': 'good-csrf',
    'content-type': 'application/json',
    ...extra,
  };
}

function dataOf<T>(response: LightMyRequestResponse): T {
  const body = response.json() as { ok: boolean; data: T };
  expect(body.ok).toBe(true);
  return body.data;
}

interface StructuredShape {
  record: {
    id: number;
    type: string;
    url: string;
    desc: string;
    sourceId: string | null;
    duplicate?: boolean;
  };
  bibliography: {
    markId: number;
    title: string | null;
    doi: string | null;
    pmid: string | null;
    year: number | null;
  } | null;
  duplicate?: boolean;
}

describe('structured parsing (pure)', () => {
  it('derives sourceId and url from DOI, desc from title', () => {
    const input = parseStructuredCreateBody({ title: 'Studi A', doi: '10.1000/ABC' });
    expect(input.record.type).toBe('link');
    expect(input.record.sourceId).toBe('doi:10.1000/abc');
    expect(input.record.url).toBe('https://doi.org/10.1000/abc');
    expect(input.record.desc).toBe('Studi A');
    expect(input.bibliography.doi).toBe('10.1000/abc');
  });

  it('derives url from PMID when no DOI or url is given', () => {
    expect(
      deriveRecordUrl({
        title: undefined,
        authors: undefined,
        journal: undefined,
        year: undefined,
        doi: undefined,
        pmid: '12345678',
        pmcid: undefined,
        url: undefined,
        oaFlag: undefined,
      }),
    ).toBe('https://pubmed.ncbi.nlm.nih.gov/12345678/');
  });

  it('rejects a create with no identifier and no url', () => {
    expect(() => parseStructuredCreateBody({ title: 'Tanpa id' })).toThrow();
  });

  it('merge keeps stored values for absent patch fields', () => {
    const merged = mergeBibliography(
      {
        markId: 1,
        workspaceId: WORKSPACE_ID,
        title: 'Lama',
        authors: null,
        journal: null,
        year: 2020,
        doi: '10.1000/abc',
        pmid: null,
        pmcid: null,
        url: null,
        oaFlag: null,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        title: undefined,
        authors: 'Doe J',
        journal: undefined,
        year: undefined,
        doi: undefined,
        pmid: undefined,
        pmcid: undefined,
        url: undefined,
        oaFlag: undefined,
      },
    );
    expect(merged.title).toBe('Lama');
    expect(merged.authors).toBe('Doe J');
    expect(merged.year).toBe(2020);
  });

  it('conflict comparison only flags fields present on both sides', () => {
    const fields = conflictingBibliographyFields(
      {
        markId: 1,
        workspaceId: WORKSPACE_ID,
        title: 'Lama',
        authors: null,
        journal: null,
        year: 2020,
        doi: '10.1000/abc',
        pmid: null,
        pmcid: null,
        url: null,
        oaFlag: null,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        title: 'Baru',
        authors: 'Doe J',
        journal: undefined,
        year: undefined,
        doi: '10.1000/abc',
        pmid: undefined,
        pmcid: undefined,
        url: undefined,
        oaFlag: undefined,
      },
    );
    expect(fields).toEqual(['title']);
  });
});

describe('structured records routes', () => {
  it('creates record + bibliography (201) and reads them back', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/records/structured',
      headers: authHeaders(),
      payload: { title: 'Studi A', authors: 'Doe J', year: 2024, doi: '10.1000/abc' },
    });
    expect(created.statusCode).toBe(201);
    const body = dataOf<StructuredShape>(created);
    expect(body.record.type).toBe('link');
    expect(body.record.sourceId).toBe('doi:10.1000/abc');
    expect(body.bibliography?.doi).toBe('10.1000/abc');

    const read = await app.inject({
      method: 'GET',
      url: `/api/records/structured/${body.record.id}`,
      headers: authHeaders(),
    });
    expect(read.statusCode).toBe(200);
    const readBody = dataOf<StructuredShape>(read);
    expect(readBody.bibliography?.title).toBe('Studi A');
    expect(readBody.bibliography?.year).toBe(2024);
  });

  it('idempotent retry returns the same record as duplicate', async () => {
    const { app } = await setup();
    const payload = { title: 'Studi A', doi: '10.1000/abc' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/records/structured',
      headers: authHeaders(),
      payload,
    });
    const firstBody = dataOf<StructuredShape>(first);
    const second = await app.inject({
      method: 'POST',
      url: '/api/records/structured',
      headers: authHeaders(),
      payload,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = dataOf<StructuredShape>(second);
    expect(secondBody.record.id).toBe(firstBody.record.id);
    expect(secondBody.duplicate).toBe(true);
  });

  it('same DOI with different metadata answers 409 with conflicting fields', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/records/structured',
      headers: authHeaders(),
      payload: { title: 'Studi A', year: 2024, doi: '10.1000/abc' },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/records/structured',
      headers: authHeaders(),
      payload: { title: 'Studi A', year: 2025, doi: '10.1000/abc' },
    });
    expect(conflict.statusCode).toBe(409);
    const body = conflict.json() as {
      error: { code: string; details?: { conflictingFields?: string[] } };
    };
    expect(body.error.code).toBe('already_exists');
    expect(body.error.details?.conflictingFields).toEqual(['year']);
  });

  it('PATCH corrects bibliography fields and guards identifier collisions', async () => {
    const { app } = await setup();
    const first = await app.inject({
      method: 'POST',
      url: '/api/records/structured',
      headers: authHeaders(),
      payload: { title: 'Studi A', doi: '10.1000/abc' },
    });
    const firstBody = dataOf<StructuredShape>(first);
    const second = await app.inject({
      method: 'POST',
      url: '/api/records/structured',
      headers: authHeaders(),
      payload: { title: 'Studi B', doi: '10.1000/def' },
    });
    const secondBody = dataOf<StructuredShape>(second);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/records/structured/${firstBody.record.id}`,
      headers: authHeaders(),
      payload: { year: 2023, journal: 'J Urol' },
    });
    expect(patched.statusCode).toBe(200);
    const patchedBody = dataOf<StructuredShape>(patched);
    expect(patchedBody.bibliography?.year).toBe(2023);
    expect(patchedBody.bibliography?.title).toBe('Studi A');

    const collision = await app.inject({
      method: 'PATCH',
      url: `/api/records/structured/${secondBody.record.id}`,
      headers: authHeaders(),
      payload: { doi: '10.1000/abc' },
    });
    expect(collision.statusCode).toBe(409);
  });

  it('GET of a plain record returns bibliography null; unknown id 404', async () => {
    const { app, records } = await setup();
    const plain = await records.createMark(
      WORKSPACE_ID,
      {
        type: 'text',
        content: 'catatan biasa',
        desc: 'catatan biasa',
        url: '',
        tagId: undefined,
        tagIds: undefined,
        sourceId: 'plain-1',
      },
      async () => false,
    );
    const read = await app.inject({
      method: 'GET',
      url: `/api/records/structured/${plain.row.id}`,
      headers: authHeaders(),
    });
    expect(read.statusCode).toBe(200);
    expect(dataOf<StructuredShape>(read).bibliography).toBeNull();

    const unknown = await app.inject({
      method: 'GET',
      url: '/api/records/structured/9999',
      headers: authHeaders(),
    });
    expect(unknown.statusCode).toBe(404);
  });
});
