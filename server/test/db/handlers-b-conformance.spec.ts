// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Conformance and validation tests for the group B db handlers
// (wiki, knowledge, vector). These tests need no database: they pin
// the handler files to the kind split, pin the kind membership to
// the typed catalog text, and prove every W1 handler rejects
// forbidden and unknown fields before any query runs. Database
// behavior lives in handlers-b.spec.ts.
//
// The group check below mirrors the route validation rules
// (canonical contract 3.4, K-14) from the catalog arrays; the real
// enforcement lives in the route module owned by the route worker,
// not in this file.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/plugins/envelope.js';
import {
  HANDLER_KIND as KNOWLEDGE_GET_SOURCE_KIND,
  validate as validateKnowledgeGetSource,
} from '../../src/services/db/knowledge-get-source.js';
import {
  HANDLER_KIND as KNOWLEDGE_LIST_SOURCES_KIND,
  validate as validateKnowledgeListSources,
} from '../../src/services/db/knowledge-list-sources.js';
import {
  HANDLER_KIND as KNOWLEDGE_REMOVE_SOURCE_KIND,
  validate as validateKnowledgeRemoveSource,
} from '../../src/services/db/knowledge-remove-source.js';
import {
  HANDLER_KIND as KNOWLEDGE_STATS_KIND,
  validate as validateKnowledgeStats,
} from '../../src/services/db/knowledge-stats.js';
import {
  HANDLER_KIND as KNOWLEDGE_UPDATE_STATUS_KIND,
  validate as validateKnowledgeUpdateStatus,
} from '../../src/services/db/knowledge-update-status.js';
import {
  HANDLER_KIND as KNOWLEDGE_UPSERT_SOURCE_KIND,
  validate as validateKnowledgeUpsertSource,
} from '../../src/services/db/knowledge-upsert-source.js';
import {
  HANDLER_KIND as VECTOR_REPLACE_CHUNKS_KIND,
  handle as handleVectorReplaceChunks,
} from '../../src/services/db/vector-replace-chunks.js';
import {
  HANDLER_KIND as VECTOR_SUMMARIES_KIND,
  validate as validateVectorSummaries,
} from '../../src/services/db/vector-summaries.js';
import {
  HANDLER_KIND as WIKI_COMMIT_REVISION_KIND,
  handle as handleWikiCommitRevision,
} from '../../src/services/db/wiki-commit-revision.js';
import {
  HANDLER_KIND as WIKI_FIND_REVISION_KIND,
  validate as validateWikiFindRevision,
} from '../../src/services/db/wiki-find-revision-by-input-hash.js';
import {
  HANDLER_KIND as WIKI_GET_ACTIVE_REVISIONS_KIND,
  validate as validateWikiGetActiveRevisions,
} from '../../src/services/db/wiki-get-active-revisions.js';
import {
  HANDLER_KIND as WIKI_GET_META_KIND,
  validate as validateWikiGetMeta,
} from '../../src/services/db/wiki-get-meta.js';
import {
  HANDLER_KIND as WIKI_GET_PAGE_KIND,
  validate as validateWikiGetPage,
} from '../../src/services/db/wiki-get-page.js';
import {
  HANDLER_KIND as WIKI_GET_REVISION_KIND,
  validate as validateWikiGetRevision,
} from '../../src/services/db/wiki-get-revision.js';
import {
  HANDLER_KIND as WIKI_GET_SEGMENT_KIND,
  validate as validateWikiGetSegment,
} from '../../src/services/db/wiki-get-segment.js';
import {
  HANDLER_KIND as WIKI_GET_SOURCE_STATE_KIND,
  validate as validateWikiGetSourceState,
} from '../../src/services/db/wiki-get-source-state.js';
import {
  HANDLER_KIND as WIKI_LIST_JOBS_KIND,
  validate as validateWikiListJobs,
} from '../../src/services/db/wiki-list-jobs.js';
import {
  HANDLER_KIND as WIKI_LIST_PAGES_KIND,
  validate as validateWikiListPages,
} from '../../src/services/db/wiki-list-pages.js';
import {
  HANDLER_KIND as WIKI_LIST_SOURCE_STATES_KIND,
  validate as validateWikiListSourceStates,
} from '../../src/services/db/wiki-list-source-states.js';
import {
  HANDLER_KIND as WIKI_PUT_META_KIND,
  handle as handleWikiPutMeta,
} from '../../src/services/db/wiki-put-meta.js';
import {
  HANDLER_KIND as WIKI_PUT_SEGMENT_KIND,
  handle as handleWikiPutSegment,
} from '../../src/services/db/wiki-put-segment.js';
import {
  HANDLER_KIND as WIKI_REMOVE_JOB_KIND,
  handle as handleWikiRemoveJob,
} from '../../src/services/db/wiki-remove-job.js';
import {
  HANDLER_KIND as WIKI_UPSERT_JOB_KIND,
  handle as handleWikiUpsertJob,
} from '../../src/services/db/wiki-upsert-job.js';
import {
  HANDLER_KIND as WIKI_UPSERT_PAGE_KIND,
  handle as handleWikiUpsertPage,
} from '../../src/services/db/wiki-upsert-page.js';
import {
  HANDLER_KIND as WIKI_UPSERT_SOURCE_KIND,
  handle as handleWikiUpsertSource,
} from '../../src/services/db/wiki-upsert-source.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDLER_DIR = join(HERE, '..', '..', 'src', 'services', 'db');
const CATALOG_PATH = join(HERE, '..', '..', '..', 'src', 'lib', 'platform', 'sql', 'ops-catalog.ts');

const READ_KINDS_B = [
  'knowledge.listSources',
  'knowledge.getSource',
  'knowledge.stats',
  'vector.summaries',
  'wiki.getSourceState',
  'wiki.listSourceStates',
  'wiki.getRevision',
  'wiki.findRevisionByInputHash',
  'wiki.getActiveRevisions',
  'wiki.listPages',
  'wiki.getPage',
  'wiki.listJobs',
  'wiki.getSegment',
  'wiki.getMeta',
] as const;

const WRITE_KINDS_B = [
  'knowledge.upsertSource',
  'knowledge.updateStatus',
  'knowledge.removeSource',
  'vector.replaceChunks',
  'wiki.upsertSource',
  'wiki.commitRevision',
  'wiki.upsertPage',
  'wiki.upsertJob',
  'wiki.removeJob',
  'wiki.putSegment',
  'wiki.putMeta',
] as const;

const ALL_KINDS_B: readonly string[] = [...READ_KINDS_B, ...WRITE_KINDS_B];

function kebab(kind: string): string {
  const dashed = kind.replace('.', '-').replace(/(?<=[a-z0-9])(?=[A-Z])/g, '-');
  return `${dashed.toLowerCase()}.ts`;
}

function expectApiError(fn: () => unknown, statusCode: number, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.statusCode).toBe(statusCode);
    expect(apiError.code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${statusCode} ${code}, but nothing was thrown`);
}

async function expectAsyncApiError(
  promise: Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.statusCode).toBe(statusCode);
    expect(apiError.code).toBe(code);
    return apiError;
  }
  throw new Error(`expected ApiError ${statusCode} ${code}, but nothing was thrown`);
}

describe('group B handler files (V-2/V-3)', () => {
  it('has all 25 kebab-named handler files and no barrel', () => {
    // NOTE (V3-13c integration): on the isolated worker branch this
    // test asserted exact directory equality. On the merged tree
    // the directory also holds the V3-13a infrastructure modules
    // and the V3-13b handler files, so exact equality is the wrong
    // invariant here. What this test pins post-merge is: every
    // group-B kind file exists under its kebab name, and there is
    // no barrel (the wiring imports handler files directly).
    const files = readdirSync(HANDLER_DIR)
      .filter((name) => name.endsWith('.ts'))
      .sort();
    const expected = ALL_KINDS_B.map(kebab).sort();
    for (const name of expected) {
      expect(files).toContain(name);
    }
    expect(files).not.toContain('index.ts');
  });

  it('has exactly one HANDLER_KIND marker per file, 25 unique markers', () => {
    const markers: string[] = [];
    for (const kind of ALL_KINDS_B) {
      const text = readFileSync(join(HANDLER_DIR, kebab(kind)), 'utf8');
      const matches = text.match(/HANDLER_KIND = '([a-zA-Z.]+)'/g) ?? [];
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(`HANDLER_KIND = '${kind}'`);
      markers.push(kind);
    }
    expect(new Set(markers).size).toBe(25);
  });

  it('imports no other handler file and no barrel helper', () => {
    for (const kind of ALL_KINDS_B) {
      const text = readFileSync(join(HANDLER_DIR, kebab(kind)), 'utf8');
      for (const line of text.split('\n')) {
        if (line.startsWith('import ') || line.startsWith('} from ')) {
          expect(line).not.toMatch(/from '\.\/(knowledge|vector|wiki)-/);
        }
      }
      expect(text).not.toMatch(/from '\.\/index\.js'/);
    }
  });

  it('exports the marker constant with the exact kind literal', () => {
    expect(KNOWLEDGE_LIST_SOURCES_KIND).toBe('knowledge.listSources');
    expect(KNOWLEDGE_GET_SOURCE_KIND).toBe('knowledge.getSource');
    expect(KNOWLEDGE_STATS_KIND).toBe('knowledge.stats');
    expect(KNOWLEDGE_UPSERT_SOURCE_KIND).toBe('knowledge.upsertSource');
    expect(KNOWLEDGE_UPDATE_STATUS_KIND).toBe('knowledge.updateStatus');
    expect(KNOWLEDGE_REMOVE_SOURCE_KIND).toBe('knowledge.removeSource');
    expect(VECTOR_SUMMARIES_KIND).toBe('vector.summaries');
    expect(VECTOR_REPLACE_CHUNKS_KIND).toBe('vector.replaceChunks');
    expect(WIKI_GET_SOURCE_STATE_KIND).toBe('wiki.getSourceState');
    expect(WIKI_LIST_SOURCE_STATES_KIND).toBe('wiki.listSourceStates');
    expect(WIKI_GET_REVISION_KIND).toBe('wiki.getRevision');
    expect(WIKI_FIND_REVISION_KIND).toBe('wiki.findRevisionByInputHash');
    expect(WIKI_GET_ACTIVE_REVISIONS_KIND).toBe('wiki.getActiveRevisions');
    expect(WIKI_LIST_PAGES_KIND).toBe('wiki.listPages');
    expect(WIKI_GET_PAGE_KIND).toBe('wiki.getPage');
    expect(WIKI_LIST_JOBS_KIND).toBe('wiki.listJobs');
    expect(WIKI_GET_SEGMENT_KIND).toBe('wiki.getSegment');
    expect(WIKI_GET_META_KIND).toBe('wiki.getMeta');
    expect(WIKI_UPSERT_SOURCE_KIND).toBe('wiki.upsertSource');
    expect(WIKI_COMMIT_REVISION_KIND).toBe('wiki.commitRevision');
    expect(WIKI_UPSERT_PAGE_KIND).toBe('wiki.upsertPage');
    expect(WIKI_UPSERT_JOB_KIND).toBe('wiki.upsertJob');
    expect(WIKI_REMOVE_JOB_KIND).toBe('wiki.removeJob');
    expect(WIKI_PUT_SEGMENT_KIND).toBe('wiki.putSegment');
    expect(WIKI_PUT_META_KIND).toBe('wiki.putMeta');
  });

  it('contains no DDL text and no raw SQL field name in handler code', () => {
    for (const kind of ALL_KINDS_B) {
      const text = readFileSync(join(HANDLER_DIR, kebab(kind)), 'utf8');
      expect(text).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE|CREATE INDEX|CREATE TRIGGER/);
    }
  });
});

describe('group B kinds against the catalog text', () => {
  function catalogKindArray(name: string): string[] {
    const text = readFileSync(CATALOG_PATH, 'utf8');
    const match = new RegExp(`${name} = \\[([\\s\\S]*?)\\]`, 'm').exec(text);
    expect(match).not.toBeNull();
    return [...(match as RegExpExecArray)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  it('places the 14 read kinds in the read array only', () => {
    const reads = catalogKindArray('SQL_READ_OP_KINDS');
    const writes = catalogKindArray('SQL_WRITE_OP_KINDS');
    for (const kind of READ_KINDS_B) {
      expect(reads).toContain(kind);
      expect(writes).not.toContain(kind);
    }
  });

  it('places the 11 write kinds in the write array only', () => {
    const reads = catalogKindArray('SQL_READ_OP_KINDS');
    const writes = catalogKindArray('SQL_WRITE_OP_KINDS');
    for (const kind of WRITE_KINDS_B) {
      expect(writes).toContain(kind);
      expect(reads).not.toContain(kind);
    }
  });

  it('keeps the read and write arrays disjoint with no duplicates', () => {
    const reads = catalogKindArray('SQL_READ_OP_KINDS');
    const writes = catalogKindArray('SQL_WRITE_OP_KINDS');
    expect(new Set(reads).size).toBe(reads.length);
    expect(new Set(writes).size).toBe(writes.length);
    expect(reads.filter((kind) => writes.includes(kind))).toEqual([]);
  });
});

describe('endpoint group rule mirrored from the catalog (K-14)', () => {
  function catalogKindArray(name: string): Set<string> {
    const text = readFileSync(CATALOG_PATH, 'utf8');
    const match = new RegExp(`${name} = \\[([\\s\\S]*?)\\]`, 'm').exec(text) as RegExpExecArray;
    return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  }

  function groupCheck(kind: string, group: 'read' | 'write'): void {
    const reads = catalogKindArray('SQL_READ_OP_KINDS');
    const writes = catalogKindArray('SQL_WRITE_OP_KINDS');
    const actual = reads.has(kind) ? 'read' : writes.has(kind) ? 'write' : null;
    if (actual === null || actual !== group) {
      throw new ApiError(400, 'invalid_operation', 'The operation is not valid for this endpoint.');
    }
  }

  it('rejects every group B write kind on the read batch endpoint with 400 invalid_operation', () => {
    for (const kind of WRITE_KINDS_B) {
      expectApiError(() => groupCheck(kind, 'read'), 400, 'invalid_operation');
    }
  });

  it('rejects every group B read kind on the transaction endpoint with 400 invalid_operation', () => {
    for (const kind of READ_KINDS_B) {
      expectApiError(() => groupCheck(kind, 'write'), 400, 'invalid_operation');
    }
  });

  it('accepts every group B kind on its own endpoint group', () => {
    for (const kind of READ_KINDS_B) {
      expect(() => groupCheck(kind, 'read')).not.toThrow();
    }
    for (const kind of WRITE_KINDS_B) {
      expect(() => groupCheck(kind, 'write')).not.toThrow();
    }
  });

  it('rejects an unknown kind on both endpoints with 400 invalid_operation', () => {
    expectApiError(() => groupCheck('knowledge.nope', 'read'), 400, 'invalid_operation');
    expectApiError(() => groupCheck('knowledge.nope', 'write'), 400, 'invalid_operation');
  });
});

const FORBIDDEN_FIELDS = ['sql', 'query', 'statement', 'table', 'columns', 'raw'] as const;

function validSource(): Record<string, unknown> {
  return {
    sourceKey: 'article:notes/a.md',
    sourceType: 'article',
    sourceId: 'notes/a.md',
    title: 'A',
    contentHash: 'hash-1',
    updatedAt: 1700000000000,
    locator: {},
    status: 'pending',
  };
}

const VALID_OPS: Array<{ kind: string; op: Record<string, unknown>; validate: (op: unknown) => void }> = [
  {
    kind: 'knowledge.listSources',
    op: { kind: 'knowledge.listSources', sourceTypes: ['article'], statuses: ['pending'], limit: 10 },
    validate: validateKnowledgeListSources,
  },
  {
    kind: 'knowledge.getSource',
    op: { kind: 'knowledge.getSource', sourceKey: 'article:a' },
    validate: validateKnowledgeGetSource,
  },
  { kind: 'knowledge.stats', op: { kind: 'knowledge.stats' }, validate: validateKnowledgeStats },
  {
    kind: 'knowledge.upsertSource',
    op: { kind: 'knowledge.upsertSource', source: validSource() },
    validate: validateKnowledgeUpsertSource,
  },
  {
    kind: 'knowledge.updateStatus',
    op: { kind: 'knowledge.updateStatus', sourceKey: 'article:a', update: { status: 'indexing' } },
    validate: validateKnowledgeUpdateStatus,
  },
  {
    kind: 'knowledge.removeSource',
    op: { kind: 'knowledge.removeSource', sourceKey: 'article:a' },
    validate: validateKnowledgeRemoveSource,
  },
  { kind: 'vector.summaries', op: { kind: 'vector.summaries' }, validate: validateVectorSummaries },
  {
    kind: 'wiki.getSourceState',
    op: { kind: 'wiki.getSourceState', contextId: 'ctx', stableId: 's1' },
    validate: validateWikiGetSourceState,
  },
  {
    kind: 'wiki.listSourceStates',
    op: { kind: 'wiki.listSourceStates', contextId: 'ctx' },
    validate: validateWikiListSourceStates,
  },
  {
    kind: 'wiki.getRevision',
    op: { kind: 'wiki.getRevision', contextId: 'ctx', id: 'r1' },
    validate: validateWikiGetRevision,
  },
  {
    kind: 'wiki.findRevisionByInputHash',
    op: { kind: 'wiki.findRevisionByInputHash', contextId: 'ctx', inputHash: 'h' },
    validate: validateWikiFindRevision,
  },
  {
    kind: 'wiki.getActiveRevisions',
    op: { kind: 'wiki.getActiveRevisions', contextId: 'ctx' },
    validate: validateWikiGetActiveRevisions,
  },
  {
    kind: 'wiki.listPages',
    op: { kind: 'wiki.listPages', contextId: 'ctx' },
    validate: validateWikiListPages,
  },
  {
    kind: 'wiki.getPage',
    op: { kind: 'wiki.getPage', contextId: 'ctx', id: 'p1' },
    validate: validateWikiGetPage,
  },
  {
    kind: 'wiki.listJobs',
    op: { kind: 'wiki.listJobs', contextId: 'ctx' },
    validate: validateWikiListJobs,
  },
  {
    kind: 'wiki.getSegment',
    op: { kind: 'wiki.getSegment', contextId: 'ctx', key: 'k' },
    validate: validateWikiGetSegment,
  },
  {
    kind: 'wiki.getMeta',
    op: { kind: 'wiki.getMeta', contextId: 'ctx', key: 'k' },
    validate: validateWikiGetMeta,
  },
];

describe('per-kind validation (W1 handlers)', () => {
  it('accepts a well-formed operation for every W1 kind', () => {
    for (const entry of VALID_OPS) {
      expect(() => entry.validate(entry.op)).not.toThrow();
    }
  });

  it('rejects a forbidden sql field on every W1 kind with 400 validation_failed', () => {
    for (const entry of VALID_OPS) {
      expectApiError(
        () => entry.validate({ ...entry.op, sql: 'select 1' }),
        400,
        'validation_failed',
      );
    }
  });

  it('rejects every forbidden field name on representative kinds', () => {
    const representatives = [VALID_OPS[1], VALID_OPS[3], VALID_OPS[7]];
    for (const entry of representatives) {
      for (const field of FORBIDDEN_FIELDS) {
        expectApiError(
          () => entry.validate({ ...entry.op, [field]: 'x' }),
          400,
          'validation_failed',
        );
      }
    }
  });

  it('rejects an unknown field on every W1 kind', () => {
    for (const entry of VALID_OPS) {
      expectApiError(
        () => entry.validate({ ...entry.op, workspaceId: 'w' }),
        400,
        'validation_failed',
      );
    }
  });

  it('rejects a mismatched kind on every W1 kind', () => {
    for (const entry of VALID_OPS) {
      expectApiError(
        () => entry.validate({ ...entry.op, kind: 'marks.list' }),
        400,
        'validation_failed',
      );
    }
  });

  it('rejects a non-object operation on every W1 kind', () => {
    for (const entry of VALID_OPS) {
      expectApiError(() => entry.validate('nope'), 400, 'validation_failed');
      expectApiError(() => entry.validate(null), 400, 'validation_failed');
    }
  });

  it('rejects wrong field types on representative kinds', () => {
    expectApiError(
      () => validateKnowledgeGetSource({ kind: 'knowledge.getSource', sourceKey: 42 }),
      400,
      'validation_failed',
    );
    expectApiError(
      () => validateWikiGetPage({ kind: 'wiki.getPage', contextId: 'ctx', id: 7 }),
      400,
      'validation_failed',
    );
    expectApiError(
      () =>
        validateKnowledgeUpdateStatus({
          kind: 'knowledge.updateStatus',
          sourceKey: 'article:a',
          update: { status: 'indexing', expectedStatus: 'bogus' },
        }),
      400,
      'validation_failed',
    );
  });

  it('rejects unknown enum values in filters and updates', () => {
    expectApiError(
      () =>
        validateKnowledgeListSources({
          kind: 'knowledge.listSources',
          sourceTypes: ['bogus'],
        }),
      400,
      'validation_failed',
    );
    expectApiError(
      () =>
        validateKnowledgeListSources({
          kind: 'knowledge.listSources',
          statuses: ['bogus'],
        }),
      400,
      'validation_failed',
    );
    expectApiError(
      () =>
        validateKnowledgeUpdateStatus({
          kind: 'knowledge.updateStatus',
          sourceKey: 'article:a',
          update: { status: 'bogus' },
        }),
      400,
      'validation_failed',
    );
    expectApiError(
      () =>
        validateKnowledgeUpsertSource({
          kind: 'knowledge.upsertSource',
          source: { ...validSource(), status: 'bogus' },
        }),
      400,
      'validation_failed',
    );
  });

  it('rejects unknown nested fields in source, locator, and update objects', () => {
    expectApiError(
      () =>
        validateKnowledgeUpsertSource({
          kind: 'knowledge.upsertSource',
          source: { ...validSource(), extra: 1 },
        }),
      400,
      'validation_failed',
    );
    expectApiError(
      () =>
        validateKnowledgeUpsertSource({
          kind: 'knowledge.upsertSource',
          source: { ...validSource(), locator: { nope: 1 } },
        }),
      400,
      'validation_failed',
    );
    expectApiError(
      () =>
        validateKnowledgeUpdateStatus({
          kind: 'knowledge.updateStatus',
          sourceKey: 'article:a',
          update: { status: 'indexing', nope: 1 },
        }),
      400,
      'validation_failed',
    );
  });

  it('rejects a malformed cursor and an invalid limit', () => {
    expectApiError(
      () => validateKnowledgeListSources({ kind: 'knowledge.listSources', cursor: 'nope' }),
      400,
      'invalid_cursor',
    );
    expectApiError(
      () => validateKnowledgeListSources({ kind: 'knowledge.listSources', cursor: '12:' }),
      400,
      'invalid_cursor',
    );
    expectApiError(
      () => validateKnowledgeListSources({ kind: 'knowledge.listSources', limit: 0 }),
      400,
      'invalid_limit',
    );
    expectApiError(
      () => validateKnowledgeListSources({ kind: 'knowledge.listSources', limit: 2.5 }),
      400,
      'invalid_limit',
    );
    expect(() =>
      validateKnowledgeListSources({ kind: 'knowledge.listSources', limit: 500 }),
    ).not.toThrow();
  });
});

describe('W2 stubs (8 kinds)', () => {
  const stubs: Array<{ kind: string; handle: (ctx: never, op: unknown) => Promise<never> }> = [
    { kind: 'vector.replaceChunks', handle: handleVectorReplaceChunks as (ctx: never, op: unknown) => Promise<never> },
    { kind: 'wiki.upsertSource', handle: handleWikiUpsertSource as (ctx: never, op: unknown) => Promise<never> },
    { kind: 'wiki.commitRevision', handle: handleWikiCommitRevision as (ctx: never, op: unknown) => Promise<never> },
    { kind: 'wiki.upsertPage', handle: handleWikiUpsertPage as (ctx: never, op: unknown) => Promise<never> },
    { kind: 'wiki.upsertJob', handle: handleWikiUpsertJob as (ctx: never, op: unknown) => Promise<never> },
    { kind: 'wiki.removeJob', handle: handleWikiRemoveJob as (ctx: never, op: unknown) => Promise<never> },
    { kind: 'wiki.putSegment', handle: handleWikiPutSegment as (ctx: never, op: unknown) => Promise<never> },
    { kind: 'wiki.putMeta', handle: handleWikiPutMeta as (ctx: never, op: unknown) => Promise<never> },
  ];

  it('answers 410 capability_unavailable naming kind and phase for every W2 kind', async () => {
    for (const stub of stubs) {
      const error = await expectAsyncApiError(
        stub.handle({} as never, { kind: stub.kind }),
        410,
        'capability_unavailable',
      );
      expect(error.details.kind).toBe(stub.kind);
      expect(error.details.capability).toBe(stub.kind);
      expect(error.details.phase).toBe('Fase 2');
      expect(error.message).toContain(stub.kind);
      expect(error.message).toContain('Fase 2');
      expect(error.retryable).toBe(false);
    }
  });

  it('names the server-only nature of the vector chunk kind', async () => {
    const error = await expectAsyncApiError(
      handleVectorReplaceChunks({} as never, { kind: 'vector.replaceChunks' }),
      410,
      'capability_unavailable',
    );
    expect(error.message).toContain('server-only');
  });
});
