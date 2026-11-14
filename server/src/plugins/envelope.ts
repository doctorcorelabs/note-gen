// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Response envelope for JSON API endpoints.
//
// Canonical contract (fase1/kontrak-api-kanonis.md sections 2 and 6,
// which wins over the wave 1 designs for envelope and error codes):
// - Success: { ok: true, data: <value> }. For commands that return unit,
//   data is null and the web adapter returns undefined to the caller.
// - Error: { ok: false, error: { code, message, requestId, retryable,
//   details } }. details is ALWAYS present and is always an object
//   (possibly empty). Per-code fields live inside details, including
//   details.capability for capability rejections. There is no top-level
//   capability field and no optional details.
// - code is a snake_case string from the catalog in section 6 of the
//   contract. SCREAMING codes (VALIDATION_ERROR, AUTH_REQUIRED, and
//   friends) are local router/adapter codes (contract section 6.5) and
//   must never appear on the wire. Codes not in the catalog must not be
//   used without an amendment to the contract.
// - error.message is fixed English text for logs and fallback display.
//   Clients branch on code, never on message text. User-facing text
//   comes from i18n keys in the UI, never from this string.
// - retryable is true only when repeating the exact same request may
//   succeed: 429 rate_limited and 503 service_unavailable /
//   write_queue_timeout. Every 409 conflict is retryable false: a
//   conflict needs a new guard or a user decision, not a blind retry.
// - Error bodies never carry stack traces, SQL text, absolute paths,
//   argument values, or secrets. Unknown errors are replaced with a
//   generic internal_error message; the original error is only logged
//   server-side with its code.
//
// This envelope does NOT apply to the health endpoints. Health keeps its
// own Fase 0 envelope (ok, status, service, version, uptimeSeconds,
// timestamp, checks) enforced by JSON schemas with additionalProperties
// false. Health bodies must never gain envelope fields. Binary downloads
// and SSE streams are also exempt: they return raw bodies, and only
// pre-body failures use this error envelope.

import { randomUUID } from 'node:crypto';

// Full wire catalog from kontrak-api-kanonis.md section 6.2. The same
// code appears once here even when it maps to two statuses
// (revision_conflict: 412 for a header guard, 409 for a body guard).
export type ApiErrorCode =
  | 'validation_failed'
  | 'invalid_json'
  | 'invalid_path'
  | 'symlink_not_allowed'
  | 'invalid_query'
  | 'invalid_cursor'
  | 'invalid_limit'
  | 'invalid_precondition'
  | 'invalid_patch_range'
  | 'invalid_upload'
  | 'invalid_move'
  | 'invalid_operation'
  | 'not_a_directory'
  | 'confirm_required'
  | 'tag_not_found'
  | 'asset_not_found'
  | 'invalid_action_token'
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'invalid_verification_code'
  | 'invalid_setup_token'
  | 'forbidden'
  | 'csrf_invalid'
  | 'origin_rejected'
  | 'step_up_required'
  | 'not_found'
  | 'method_not_allowed'
  | 'already_exists'
  | 'target_exists'
  | 'revision_conflict'
  | 'record_tags_changed'
  | 'wrong_kind'
  | 'repair_precondition_failed'
  | 'reconcile_already_running'
  | 'idempotency_key_reused'
  | 'tag_in_use'
  | 'tag_locked'
  | 'tag_name_taken'
  | 'backup_in_progress'
  | 'capability_unavailable'
  | 'text_too_large'
  | 'media_too_large'
  | 'asset_too_large'
  | 'payload_too_large'
  | 'not_text_file'
  | 'unsupported_media_type'
  | 'range_not_satisfiable'
  | 'invalid_text_encoding'
  | 'unsupported_backup_format'
  | 'backup_corrupt'
  | 'backup_decrypt_failed'
  | 'schema_too_new'
  | 'precondition_required'
  | 'rate_limited'
  | 'internal_error'
  | 'index_update_failed'
  | 'trash_blob_missing'
  | 'fuzzy_search_unavailable'
  | 'document_parse_unavailable'
  | 'restore_unavailable'
  | 'service_unavailable'
  | 'write_queue_timeout';

export interface ApiSuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

export interface ApiErrorEnvelope {
  ok: false;
  error: ApiErrorBody;
}

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

export function ensureRequestId(value: string | undefined | null): string {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  return randomUUID();
}

export function successEnvelope<T>(data: T): ApiSuccessEnvelope<T> {
  return { ok: true, data };
}

// Details must be a JSON-serializable plain object. Anything else
// (undefined, an array, a scalar, a circular value) becomes an empty
// object, so the wire shape can never break. Handlers must pass objects
// only; dropping a malformed value is safer than sending it.
function sanitizeDetails(details: unknown): Record<string, unknown> {
  if (details === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(JSON.stringify(details)) as unknown;
  } catch {
    return {};
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

export interface ErrorEnvelopeOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function errorEnvelope(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  options: ErrorEnvelopeOptions = {},
): ApiErrorEnvelope {
  return {
    ok: false,
    error: {
      code,
      message,
      requestId: ensureRequestId(requestId),
      retryable: options.retryable ?? false,
      details: sanitizeDetails(options.details),
    },
  };
}

// Typed error thrown by handlers and hooks. The global error handler in
// error-handler.ts converts it to an envelope with its status code.
// Handlers must only use fixed, generic messages: never interpolate
// user input, SQL, paths, or secret-adjacent values into the message.
// Machine-readable context belongs in details, and only when it is safe
// to send to the client. The status code is explicit at construction
// because one code (revision_conflict) maps to two statuses.
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    options: ErrorEnvelopeOptions = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = sanitizeDetails(options.details);
  }

  static validation(message = 'Request validation failed.', details?: Record<string, unknown>): ApiError {
    return new ApiError(400, 'validation_failed', message, { details });
  }

  static invalidJson(message = 'Request body is not valid JSON.'): ApiError {
    return new ApiError(400, 'invalid_json', message);
  }

  static invalidPath(message = 'The path is not valid.'): ApiError {
    return new ApiError(400, 'invalid_path', message);
  }

  static unauthenticated(message = 'Authentication is required.'): ApiError {
    return new ApiError(401, 'unauthenticated', message);
  }

  static invalidCredentials(message = 'Email or password is incorrect.'): ApiError {
    return new ApiError(401, 'invalid_credentials', message);
  }

  static invalidVerificationCode(message = 'The verification code is incorrect or has expired.'): ApiError {
    return new ApiError(401, 'invalid_verification_code', message);
  }

  static invalidSetupToken(message = 'The setup token is not valid.'): ApiError {
    return new ApiError(401, 'invalid_setup_token', message);
  }

  static forbidden(message = 'Access is forbidden.'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  // CSRF and Origin failures share one generic message (desain-auth.md
  // section 3.7) and are distinguished only by code (kontrak section
  // 1.2), so a client can tell a stale token from a wrong origin
  // without the server leaking which layer failed in prose.
  static csrfInvalid(message = 'The request was rejected.'): ApiError {
    return new ApiError(403, 'csrf_invalid', message);
  }

  static originRejected(message = 'The request was rejected.'): ApiError {
    return new ApiError(403, 'origin_rejected', message);
  }

  static stepUpRequired(message = 'Re-authentication is required for this action.'): ApiError {
    return new ApiError(403, 'step_up_required', message);
  }

  static notFound(message = 'Resource not found.'): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static methodNotAllowed(message = 'Method not allowed.'): ApiError {
    return new ApiError(405, 'method_not_allowed', message);
  }

  static alreadyExists(message = 'The resource already exists.'): ApiError {
    return new ApiError(409, 'already_exists', message);
  }

  // One code for every optimistic guard (kontrak K-03): 412 when the
  // guard arrived in a header (If-Match), 409 when it arrived in the
  // body (expectedRevision, expectedVersion, baseRevision). The
  // conflict payload keeps the same shape in details for both.
  static revisionConflict(
    details?: Record<string, unknown>,
    options: { headerGuard?: boolean } = {},
    message = 'The resource has changed. Reload and retry with the current revision.',
  ): ApiError {
    return new ApiError(options.headerGuard === true ? 412 : 409, 'revision_conflict', message, { details });
  }

  static recordTagsChanged(details?: Record<string, unknown>): ApiError {
    return new ApiError(409, 'record_tags_changed', 'The record tags have changed.', { details });
  }

  // Fallback for a DISABLE capability that somehow reaches the server.
  // The capability name travels in details.capability, never as a
  // top-level field (kontrak section 2.2). Normal capability
  // rejections happen locally in the invoke router, without HTTP.
  static capabilityUnavailable(capability: string, message = 'This feature is not available in the web version.'): ApiError {
    return new ApiError(410, 'capability_unavailable', message, { details: { capability } });
  }

  static payloadTooLarge(message = 'Request payload is too large.'): ApiError {
    return new ApiError(413, 'payload_too_large', message);
  }

  static textTooLarge(message = 'Text is too large.'): ApiError {
    return new ApiError(413, 'text_too_large', message);
  }

  static mediaTooLarge(message = 'Media is too large.'): ApiError {
    return new ApiError(413, 'media_too_large', message);
  }

  static assetTooLarge(limitBytes?: number, message = 'Asset is too large.'): ApiError {
    return new ApiError(413, 'asset_too_large', message, {
      details: limitBytes === undefined ? {} : { limitBytes },
    });
  }

  static preconditionRequired(message = 'A precondition guard is required.'): ApiError {
    return new ApiError(428, 'precondition_required', message);
  }

  // 429 is retryable, and the response must also carry a Retry-After
  // header. The header is the rate-limit middleware's job: this factory
  // only builds the error, and the middleware sets the header before
  // the error reaches the global handler.
  static rateLimited(message = 'Too many requests.'): ApiError {
    return new ApiError(429, 'rate_limited', message, { retryable: true });
  }

  static internalError(message = 'Internal server error.'): ApiError {
    return new ApiError(500, 'internal_error', message);
  }

  static serviceUnavailable(message = 'The service is temporarily unavailable.'): ApiError {
    return new ApiError(503, 'service_unavailable', message, { retryable: true });
  }

  static writeQueueTimeout(message = 'The write queue timed out.'): ApiError {
    return new ApiError(503, 'write_queue_timeout', message, { retryable: true });
  }

  // Explicit MVP stubs (kontrak section 7). Each stub answers 501 only
  // after auth and CSRF pass, with its own specific code.
  static fuzzySearchUnavailable(
    message = 'Fuzzy search is not available yet. Keyword search still works.',
  ): ApiError {
    return new ApiError(501, 'fuzzy_search_unavailable', message);
  }

  static documentParseUnavailable(message = 'Document parsing is not available yet.'): ApiError {
    return new ApiError(501, 'document_parse_unavailable', message);
  }

  static restoreUnavailable(message = 'Backup restore is not available yet.'): ApiError {
    return new ApiError(501, 'restore_unavailable', message);
  }
}

interface FastifyLikeError {
  statusCode?: unknown;
  code?: unknown;
  validation?: unknown;
}

// Convert any thrown value to an HTTP status plus an envelope, without
// leaking the original message for unexpected errors. Fastify schema
// validation failures become validation_failed with a generic message;
// the field-level detail stays in the server log, not in the body.
// Malformed JSON bodies become invalid_json. Oversized bodies become
// payload_too_large. Anything unexpected becomes a generic
// internal_error. retryable is true only for 429 and 503 outcomes.
export function toErrorEnvelope(error: unknown, requestId: string): { statusCode: number; envelope: ApiErrorEnvelope } {
  const id = ensureRequestId(requestId);
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      envelope: errorEnvelope(error.code, error.message, id, {
        retryable: error.retryable,
        details: error.details,
      }),
    };
  }
  if (typeof error === 'object' && error !== null) {
    const fastifyError = error as FastifyLikeError;
    const statusCode = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : undefined;
    const code = typeof fastifyError.code === 'string' ? fastifyError.code : undefined;
    if (fastifyError.validation !== undefined || code === 'FST_ERR_VALIDATION') {
      return {
        statusCode: 400,
        envelope: errorEnvelope('validation_failed', 'Request validation failed.', id),
      };
    }
    // Fastify 5 names the malformed-JSON error
    // FST_ERR_CTP_INVALID_JSON_BODY (verified in fastify 5.12.8,
    // lib/errors.js); the older _CONTENT name is kept for safety.
    if (
      code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      code === 'FST_ERR_CTP_INVALID_JSON_CONTENT' ||
      code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      return {
        statusCode: 400,
        envelope: errorEnvelope('invalid_json', 'Request body is not valid JSON.', id),
      };
    }
    if (statusCode === 413 || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return {
        statusCode: 413,
        envelope: errorEnvelope('payload_too_large', 'Request payload is too large.', id),
      };
    }
    if (statusCode === 401) {
      return {
        statusCode: 401,
        envelope: errorEnvelope('unauthenticated', 'Authentication is required.', id),
      };
    }
    if (statusCode === 403) {
      return {
        statusCode: 403,
        envelope: errorEnvelope('forbidden', 'Access is forbidden.', id),
      };
    }
    if (statusCode === 404) {
      return {
        statusCode: 404,
        envelope: errorEnvelope('not_found', 'Resource not found.', id),
      };
    }
    if (statusCode === 405) {
      return {
        statusCode: 405,
        envelope: errorEnvelope('method_not_allowed', 'Method not allowed.', id),
      };
    }
    if (statusCode === 415) {
      return {
        statusCode: 415,
        envelope: errorEnvelope('unsupported_media_type', 'Unsupported media type.', id),
      };
    }
    if (statusCode === 429) {
      return {
        statusCode: 429,
        envelope: errorEnvelope('rate_limited', 'Too many requests.', id, { retryable: true }),
      };
    }
    if (statusCode === 503) {
      return {
        statusCode: 503,
        envelope: errorEnvelope('service_unavailable', 'The service is temporarily unavailable.', id, { retryable: true }),
      };
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return {
        statusCode,
        envelope: errorEnvelope('validation_failed', 'Request failed.', id),
      };
    }
  }
  return {
    statusCode: 500,
    envelope: errorEnvelope('internal_error', 'Internal server error.', id),
  };
}
