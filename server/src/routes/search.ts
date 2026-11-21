// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Search routes (V3-27 skeleton, Fase 1 wave 3B overlap).
//
//   GET  /api/search        keyword search over records and files
//   POST /api/search/fuzzy  explicit 501 stub (Fase 2 capability)
//
// Keyword search (kontrak-api-kanonis.md section 3.9, V1-14
// section 8) is a pure read: session auth only, no CSRF or Origin
// check (the frozen auth hook skips both for non-mutations), no
// writes, no index enqueue. The handler validates and normalizes
// the wire query, then delegates to the injected KeywordSearchPort
// (services/search/port.ts). The index-backed port waits for
// V3-06/V3-25; this skeleton is wired against the fake port in
// tests, and the integrator swaps in the real port in the app.ts
// search block without touching this file.
//
// The fuzzy stub follows the stubs.ts pattern (kontrak section 7):
// auth first, shape validation before rejection, its own stable
// error code, no side effects. The 501 code is
// fuzzy_search_unavailable, from the contract catalog (section 6),
// with the shared ApiError factory message naming keyword search
// as the working MVP path. Shape validation checks framing only
// against the reserved Fase 2 body (kontrak 3.9 and 7.2, V1-14
// 9.3); it never scores anything and never reads the database.
// POST /api/search does NOT exist: advanced search is a Fase 2
// reservation (kontrak section 8) and answers the generic 404.
//
// Authentication comes from the frozen global auth hook
// (middleware/auth-hook.ts): both routes set requiresAuth true.
// Handlers also read the principal with getPrincipal and fail
// closed with 401 when it is absent, so the routes stay denied if
// they are ever registered without the hook. Unknown query
// parameters are ignored (kontrak 1.5.2); unknown JSON body
// fields are rejected (kontrak 1.5.1).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPrincipal, type SessionPrincipal } from '../middleware/auth-hook.js';
import { ApiError, successEnvelope } from '../plugins/envelope.js';
import type {
  KeywordSearchInput,
  KeywordSearchPort,
  SearchResultItem,
  SearchScope,
} from '../services/search/port.js';

export const SEARCH_PATH = '/api/search';
export const FUZZY_SEARCH_PATH = '/api/search/fuzzy';

// Pagination (kontrak 1.4.2, V1-14 8.1): default limit 50, maximum
// 200. A limit above the maximum is clamped, never an error; a
// limit below 1 or not an integer answers invalid_limit.
export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 200;

// Query bounds (V1-14 8.1 for keyword, 9.3 for fuzzy): 1-200
// characters after trimming.
export const SEARCH_MAX_QUERY_CHARS = 200;

// Reserved Fase 2 fuzzy body bounds (V1-14 9.3): 1-2000 items,
// 1-10 keys, limit default 50 and maximum 200.
export const FUZZY_MAX_ITEMS = 2000;
export const FUZZY_MAX_KEYS = 10;
export const FUZZY_MAX_LIMIT = 200;

// The fuzzy status block of every keyword response (V1-14 8.2).
// In MVP, fuzzy matching is declared unavailable; that is a
// stated status, not a degradation. The separate degraded flag
// (DA-2 F-15-03) reports loader partiality from the search port:
// true when files were skipped because of read errors or the
// version map failed, so results may be incomplete.
export const SEARCH_FUZZY_STATUS = {
  available: false,
  reason: 'not_in_mvp',
  message: 'Fuzzy matching is not available in this version. Results below are keyword matches only.',
} as const;

export interface KeywordSearchResponseData {
  query: string;
  scope: SearchScope;
  results: SearchResultItem[];
  nextCursor: string | null;
  hasMore: boolean;
  fuzzy: {
    available: false;
    reason: 'not_in_mvp';
    message: string;
  };
  degraded: boolean;
}

export interface SearchRouteDeps {
  search: KeywordSearchPort;
}

export interface ValidationFieldIssue {
  field: string;
  issue: string;
}

function failValidation(issues: ValidationFieldIssue[]): never {
  throw ApiError.validation('Request validation failed.', { fields: issues });
}

function requirePrincipal(request: FastifyRequest): SessionPrincipal {
  const principal = getPrincipal(request);
  if (principal === undefined) {
    throw ApiError.unauthenticated();
  }
  return principal;
}

function parseSearchLimit(raw: unknown): number {
  if (raw === undefined) {
    return SEARCH_DEFAULT_LIMIT;
  }
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'invalid_limit', 'The pagination limit is not valid.');
  }
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new ApiError(400, 'invalid_limit', 'The pagination limit is not valid.');
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new ApiError(400, 'invalid_limit', 'The pagination limit is not valid.');
  }
  return Math.min(parsed, SEARCH_MAX_LIMIT);
}

// Validate and normalize the GET /api/search query string.
//
// Rules (V1-14 8.1, kontrak 1.4.2, 1.5.2, 3.9):
// - q is required, 1-200 characters after trimming.
// - scope is records, files, or all, defaulting to all.
// - tagId filters record hits only and must be a positive integer.
// - type is one record type or a comma-separated list; it filters
//   record hits only.
// - tagId or type together with scope=files is a 400: the filters
//   cannot apply to file hits.
// - mode is rejected with 400: vector and hybrid search are Fase 2
//   and cannot be requested through this endpoint.
// - cursor is passed through untouched: the port owns the opaque
//   cursor encoding and answers invalid_cursor for a malformed
//   cursor or one carried to a different query.
// - Unknown query parameters are ignored, except mode above.
// All validation_failed issues are collected into one error with
// details.fields naming each field (kontrak 6.2). Limit and
// cursor failures use their own codes and throw immediately.
export function parseKeywordSearchQuery(query: unknown, principal: SessionPrincipal): KeywordSearchInput {
  const record =
    typeof query === 'object' && query !== null && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const issues: ValidationFieldIssue[] = [];

  if ('mode' in record) {
    issues.push({ field: 'mode', issue: 'unsupported' });
  }

  let trimmedQuery = '';
  const rawQ = record['q'];
  if (rawQ === undefined) {
    issues.push({ field: 'q', issue: 'required' });
  } else if (typeof rawQ !== 'string') {
    issues.push({ field: 'q', issue: 'invalid' });
  } else {
    trimmedQuery = rawQ.trim();
    if (trimmedQuery === '' || trimmedQuery.length > SEARCH_MAX_QUERY_CHARS) {
      issues.push({ field: 'q', issue: 'invalid' });
    }
  }

  let scope: SearchScope = 'all';
  const rawScope = record['scope'];
  if (rawScope !== undefined) {
    if (rawScope === 'records' || rawScope === 'files' || rawScope === 'all') {
      scope = rawScope;
    } else {
      issues.push({ field: 'scope', issue: 'invalid' });
    }
  }

  let tagId: number | undefined;
  const rawTagId = record['tagId'];
  if (rawTagId !== undefined) {
    if (typeof rawTagId === 'string' && /^\d+$/.test(rawTagId.trim())) {
      const parsed = Number(rawTagId.trim());
      if (Number.isSafeInteger(parsed) && parsed >= 1) {
        tagId = parsed;
      } else {
        issues.push({ field: 'tagId', issue: 'invalid' });
      }
    } else {
      issues.push({ field: 'tagId', issue: 'invalid' });
    }
  }

  let type: string[] | undefined;
  const rawType = record['type'];
  if (rawType !== undefined) {
    if (typeof rawType === 'string') {
      const tokens = rawType
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token !== '');
      if (tokens.length === 0) {
        issues.push({ field: 'type', issue: 'invalid' });
      } else {
        type = tokens;
      }
    } else {
      issues.push({ field: 'type', issue: 'invalid' });
    }
  }

  if (scope === 'files') {
    if (rawTagId !== undefined) {
      issues.push({ field: 'tagId', issue: 'invalid_combination' });
    }
    if (rawType !== undefined) {
      issues.push({ field: 'type', issue: 'invalid_combination' });
    }
  }

  if (issues.length > 0) {
    failValidation(issues);
  }

  const limit = parseSearchLimit(record['limit']);

  const rawCursor = record['cursor'];
  let cursor: string | undefined;
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== 'string') {
      throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is not valid.');
    }
    cursor = rawCursor;
  }

  return { principal, query: trimmedQuery, scope, tagId, type, cursor, limit };
}

const FUZZY_ALLOWED_FIELDS = new Set(['query', 'items', 'keys', 'threshold', 'limit']);
const FUZZY_ITEM_ALLOWED_FIELDS = new Set(['id', 'keys']);

// Validate the POST /api/search/fuzzy request SHAPE only, against
// the reserved Fase 2 body (kontrak 3.9 and 7.2, V1-14 9.3):
// { query, items[{ id, keys }], keys, threshold?, limit? }.
// A well-formed request is answered 501 by the handler; a
// malformed one is answered 400 validation_failed here, before
// the rejection, following the stubs.ts pattern. No scoring runs,
// no item content is interpreted beyond its framing, and unknown
// fields are rejected with details.fields naming each one
// (kontrak 1.5.1). Item keys that a given item lacks are treated
// as empty strings in Fase 2, not as errors, so a keys object may
// omit keys; it must still be an object of strings.
export function validateFuzzyRequestBody(body: unknown): void {
  const issues: ValidationFieldIssue[] = [];
  if (body === undefined) {
    failValidation([{ field: 'body', issue: 'required' }]);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    failValidation([{ field: 'body', issue: 'invalid' }]);
  }
  const record = body as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!FUZZY_ALLOWED_FIELDS.has(key)) {
      issues.push({ field: key, issue: 'unknown_field' });
    }
  }

  const rawQuery = record['query'];
  if (rawQuery === undefined) {
    issues.push({ field: 'query', issue: 'required' });
  } else if (typeof rawQuery !== 'string') {
    issues.push({ field: 'query', issue: 'invalid' });
  } else {
    const trimmed = rawQuery.trim();
    if (trimmed === '' || trimmed.length > SEARCH_MAX_QUERY_CHARS) {
      issues.push({ field: 'query', issue: 'invalid' });
    }
  }

  const rawItems = record['items'];
  if (rawItems === undefined) {
    issues.push({ field: 'items', issue: 'required' });
  } else if (!Array.isArray(rawItems)) {
    issues.push({ field: 'items', issue: 'invalid' });
  } else {
    if (rawItems.length < 1 || rawItems.length > FUZZY_MAX_ITEMS) {
      issues.push({ field: 'items', issue: 'invalid' });
    }
    rawItems.forEach((rawItem, index) => {
      const prefix = `items[${index}]`;
      if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
        issues.push({ field: prefix, issue: 'invalid' });
        return;
      }
      const item = rawItem as Record<string, unknown>;
      for (const key of Object.keys(item)) {
        if (!FUZZY_ITEM_ALLOWED_FIELDS.has(key)) {
          issues.push({ field: `${prefix}.${key}`, issue: 'unknown_field' });
        }
      }
      const id = item['id'];
      if (id === undefined) {
        issues.push({ field: `${prefix}.id`, issue: 'required' });
      } else if (typeof id !== 'string' || id.trim() === '') {
        issues.push({ field: `${prefix}.id`, issue: 'invalid' });
      }
      const keys = item['keys'];
      if (keys === undefined) {
        issues.push({ field: `${prefix}.keys`, issue: 'required' });
      } else if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
        issues.push({ field: `${prefix}.keys`, issue: 'invalid' });
      } else {
        for (const [keyName, keyValue] of Object.entries(keys as Record<string, unknown>)) {
          if (typeof keyValue !== 'string') {
            issues.push({ field: `${prefix}.keys.${keyName}`, issue: 'invalid' });
          }
        }
      }
    });
  }

  const rawKeys = record['keys'];
  if (rawKeys === undefined) {
    issues.push({ field: 'keys', issue: 'required' });
  } else if (!Array.isArray(rawKeys)) {
    issues.push({ field: 'keys', issue: 'invalid' });
  } else {
    if (rawKeys.length < 1 || rawKeys.length > FUZZY_MAX_KEYS) {
      issues.push({ field: 'keys', issue: 'invalid' });
    }
    rawKeys.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        issues.push({ field: `keys[${index}]`, issue: 'invalid' });
      }
    });
  }

  const threshold = record['threshold'];
  if (threshold !== undefined && (typeof threshold !== 'number' || !Number.isFinite(threshold))) {
    issues.push({ field: 'threshold', issue: 'invalid' });
  }

  const limit = record['limit'];
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > FUZZY_MAX_LIMIT)
  ) {
    issues.push({ field: 'limit', issue: 'invalid' });
  }

  if (issues.length > 0) {
    failValidation(issues);
  }
}

export async function registerSearchRoutes(app: FastifyInstance, deps: SearchRouteDeps): Promise<void> {
  app.get(
    SEARCH_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      const principal = requirePrincipal(request);
      const input = parseKeywordSearchQuery(request.query, principal);
      const page = await deps.search.search(input);
      const data: KeywordSearchResponseData = {
        query: input.query,
        scope: input.scope,
        results: page.results,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        fuzzy: { ...SEARCH_FUZZY_STATUS },
        degraded: page.degraded,
      };
      return successEnvelope(data);
    },
  );

  app.post(
    FUZZY_SEARCH_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest) => {
      requirePrincipal(request);
      validateFuzzyRequestBody(request.body);
      throw ApiError.fuzzySearchUnavailable();
    },
  );
}
