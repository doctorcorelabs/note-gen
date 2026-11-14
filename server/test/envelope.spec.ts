// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the canonical response envelope (kontrak-api-kanonis.md
// sections 2.2 and 6). These tests pin the wire shape: snake_case
// codes only, details always present as an object, retryable true
// only for 429 and 503, capability inside details, and no leak of
// unexpected error messages.
//
// File name note: the root .gitignore ignores "*.test.*", which would
// silently drop a file named envelope.test.ts from git. This file uses
// the .spec.ts suffix instead, which Vitest also picks up by default.

import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ensureRequestId,
  errorEnvelope,
  successEnvelope,
  toErrorEnvelope,
} from '../src/plugins/envelope.js';

const SCREAMING = /[A-Z]/;

describe('success envelope', () => {
  it('wraps data with ok true and no extra fields', () => {
    expect(successEnvelope({ path: '/a.md', revision: 3 })).toEqual({
      ok: true,
      data: { path: '/a.md', revision: 3 },
    });
  });

  it('carries null data for unit commands', () => {
    expect(successEnvelope(null)).toEqual({ ok: true, data: null });
  });
});

describe('error envelope shape', () => {
  it('always carries details as an object, even when none is given', () => {
    const envelope = errorEnvelope('not_found', 'Resource not found.', 'req-1');
    expect(envelope).toEqual({
      ok: false,
      error: {
        code: 'not_found',
        message: 'Resource not found.',
        requestId: 'req-1',
        retryable: false,
        details: {},
      },
    });
    expect(Object.keys(envelope.error).sort()).toEqual(['code', 'details', 'message', 'requestId', 'retryable']);
  });

  it('keeps caller details and never adds a top-level capability field', () => {
    const envelope = errorEnvelope('capability_unavailable', 'Not available.', 'req-2', {
      details: { capability: 'plugin-sql' },
    });
    expect(envelope.error.details).toEqual({ capability: 'plugin-sql' });
    expect('capability' in envelope.error).toBe(false);
  });

  it('replaces a missing or blank request id with a generated one', () => {
    expect(ensureRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(ensureRequestId('  ')).toMatch(/^[0-9a-f-]{36}$/);
    expect(ensureRequestId('client-id-9')).toBe('client-id-9');
  });

  it('drops non-object details instead of breaking the wire shape', () => {
    const envelope = errorEnvelope(
      'validation_failed',
      'Request validation failed.',
      'req-3',
      // Intentionally wrong at runtime: details must be an object.
      { details: 'not-an-object' as unknown as Record<string, unknown> },
    );
    expect(envelope.error.details).toEqual({});
  });

  it('drops circular details instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const envelope = errorEnvelope('validation_failed', 'Request validation failed.', 'req-4', {
      details: circular,
    });
    expect(envelope.error.details).toEqual({});
  });
});

describe('ApiError factories', () => {
  it('uses snake_case codes with the catalog statuses', () => {
    const cases: Array<[ApiError, number, string, boolean]> = [
      [ApiError.validation(), 400, 'validation_failed', false],
      [ApiError.invalidJson(), 400, 'invalid_json', false],
      [ApiError.unauthenticated(), 401, 'unauthenticated', false],
      [ApiError.invalidCredentials(), 401, 'invalid_credentials', false],
      [ApiError.forbidden(), 403, 'forbidden', false],
      [ApiError.csrfInvalid(), 403, 'csrf_invalid', false],
      [ApiError.originRejected(), 403, 'origin_rejected', false],
      [ApiError.stepUpRequired(), 403, 'step_up_required', false],
      [ApiError.notFound(), 404, 'not_found', false],
      [ApiError.methodNotAllowed(), 405, 'method_not_allowed', false],
      [ApiError.alreadyExists(), 409, 'already_exists', false],
      [ApiError.recordTagsChanged(), 409, 'record_tags_changed', false],
      [ApiError.capabilityUnavailable('plugin-sql'), 410, 'capability_unavailable', false],
      [ApiError.payloadTooLarge(), 413, 'payload_too_large', false],
      [ApiError.preconditionRequired(), 428, 'precondition_required', false],
      [ApiError.rateLimited(), 429, 'rate_limited', true],
      [ApiError.internalError(), 500, 'internal_error', false],
      [ApiError.serviceUnavailable(), 503, 'service_unavailable', true],
      [ApiError.writeQueueTimeout(), 503, 'write_queue_timeout', true],
      [ApiError.fuzzySearchUnavailable(), 501, 'fuzzy_search_unavailable', false],
      [ApiError.documentParseUnavailable(), 501, 'document_parse_unavailable', false],
      [ApiError.restoreUnavailable(), 501, 'restore_unavailable', false],
    ];
    for (const [error, status, code, retryable] of cases) {
      expect(error.statusCode).toBe(status);
      expect(error.code).toBe(code);
      expect(error.code).not.toMatch(SCREAMING);
      expect(error.retryable).toBe(retryable);
      expect(error.details).toEqual(expect.any(Object));
    }
  });

  it('gives CSRF and Origin failures the same message but different codes', () => {
    expect(ApiError.csrfInvalid().message).toBe(ApiError.originRejected().message);
    expect(ApiError.csrfInvalid().code).not.toBe(ApiError.originRejected().code);
  });

  it('maps revision_conflict to 412 for a header guard and 409 for a body guard', () => {
    const header = ApiError.revisionConflict({ serverRevision: 'r2' }, { headerGuard: true });
    expect(header.statusCode).toBe(412);
    expect(header.code).toBe('revision_conflict');
    expect(header.details).toEqual({ serverRevision: 'r2' });
    const body = ApiError.revisionConflict({ serverRevision: 'r2' });
    expect(body.statusCode).toBe(409);
    expect(body.code).toBe('revision_conflict');
  });

  it('puts the capability name in details for capability_unavailable', () => {
    const error = ApiError.capabilityUnavailable('plugin-sql');
    expect(error.details).toEqual({ capability: 'plugin-sql' });
    expect('capability' in error).toBe(false);
  });

  it('carries limitBytes in details for asset_too_large', () => {
    expect(ApiError.assetTooLarge(1024).details).toEqual({ limitBytes: 1024 });
    expect(ApiError.assetTooLarge().details).toEqual({});
  });

  it('keeps 409 conflicts retryable false', () => {
    expect(ApiError.revisionConflict().retryable).toBe(false);
    expect(new ApiError(409, 'idempotency_key_reused', 'Key reused.').retryable).toBe(false);
  });
});

describe('toErrorEnvelope', () => {
  it('passes ApiError values through with status, code, and details', () => {
    const { statusCode, envelope } = toErrorEnvelope(
      ApiError.validation('Request validation failed.', { fields: [{ field: 'name', issue: 'required' }] }),
      'req-9',
    );
    expect(statusCode).toBe(400);
    expect(envelope.error.code).toBe('validation_failed');
    expect(envelope.error.requestId).toBe('req-9');
    expect(envelope.error.details).toEqual({ fields: [{ field: 'name', issue: 'required' }] });
  });

  it('maps Fastify schema validation failures to validation_failed', () => {
    const { statusCode, envelope } = toErrorEnvelope(
      { statusCode: 400, code: 'FST_ERR_VALIDATION', validation: [{ message: 'must be string' }] },
      'req-10',
    );
    expect(statusCode).toBe(400);
    expect(envelope.error.code).toBe('validation_failed');
    expect(envelope.error.details).toEqual({});
  });

  it('maps malformed JSON bodies to invalid_json', () => {
    for (const code of ['FST_ERR_CTP_INVALID_JSON_CONTENT', 'FST_ERR_CTP_EMPTY_JSON_BODY']) {
      const { statusCode, envelope } = toErrorEnvelope({ statusCode: 400, code }, 'req-11');
      expect(statusCode).toBe(400);
      expect(envelope.error.code).toBe('invalid_json');
    }
  });

  it('maps oversized bodies to payload_too_large', () => {
    const { statusCode, envelope } = toErrorEnvelope(
      { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' },
      'req-12',
    );
    expect(statusCode).toBe(413);
    expect(envelope.error.code).toBe('payload_too_large');
  });

  it('maps 404, 405, 415, 429, and 503 framework statuses to catalog codes', () => {
    const cases: Array<[number, string, boolean]> = [
      [404, 'not_found', false],
      [405, 'method_not_allowed', false],
      [415, 'unsupported_media_type', false],
      [429, 'rate_limited', true],
      [503, 'service_unavailable', true],
    ];
    for (const [status, code, retryable] of cases) {
      const { statusCode, envelope } = toErrorEnvelope({ statusCode: status }, 'req-13');
      expect(statusCode).toBe(status);
      expect(envelope.error.code).toBe(code);
      expect(envelope.error.retryable).toBe(retryable);
    }
  });

  it('replaces unexpected errors with a generic internal_error without leaking the message', () => {
    const marker = 'MARKER_SECRET_9f27';
    const { statusCode, envelope } = toErrorEnvelope(
      new Error(`database password is ${marker} at /srv/secret/path`),
      'req-14',
    );
    expect(statusCode).toBe(500);
    expect(envelope.error.code).toBe('internal_error');
    expect(JSON.stringify(envelope)).not.toContain(marker);
    expect(JSON.stringify(envelope)).not.toContain('/srv/secret/path');
    expect(envelope.error.details).toEqual({});
  });

  it('replaces non-Error throws with a generic internal_error', () => {
    const { statusCode, envelope } = toErrorEnvelope('boom', 'req-15');
    expect(statusCode).toBe(500);
    expect(envelope.error.code).toBe('internal_error');
  });
});
