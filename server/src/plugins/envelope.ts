// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Response envelope for JSON API endpoints.
//
// Contract (desain-invoke-router.md section 2.4, Fase 1):
// - Success: { ok: true, data: <value> }. For commands that return unit,
//   data is null and the web adapter returns undefined to the caller.
// - Error: { ok: false, error: { code, message, requestId, retryable, details? } }.
//   The optional capability field names a capability (not a command name)
//   for capability rejections, matching the invoke-router error shape.
// - error.message is fixed English text for logs and fallback display.
//   User-facing text comes from i18n keys in the UI, never from this string.
// - Error bodies never carry stack traces, SQL text, absolute paths,
//   argument values, or secrets. Unknown errors are replaced with a
//   generic SERVER_ERROR message; the original error is only logged
//   server-side with its code.
//
// This envelope does NOT apply to the health endpoints. Health keeps its
// own Fase 0 envelope (ok, status, service, version, uptimeSeconds,
// timestamp, checks) enforced by JSON schemas with additionalProperties
// false. Health bodies must never gain envelope fields. Binary downloads
// and SSE streams are also exempt: they return raw bodies, and only
// pre-body failures use this error envelope.

import { randomUUID } from 'node:crypto';

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'CSRF_FAILED'
  | 'ORIGIN_REJECTED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CAPABILITY_GATED'
  | 'FEATURE_NOT_YET_AVAILABLE'
  | 'UNKNOWN_COMMAND'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'SERVER_ERROR';

export interface ApiSuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
  details?: unknown;
  capability?: string;
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

function sanitizeDetails(details: unknown): unknown {
  if (details === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(details)) as unknown;
  } catch {
    return undefined;
  }
}

export interface ErrorEnvelopeOptions {
  retryable?: boolean;
  details?: unknown;
  capability?: string;
}

export function errorEnvelope(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  options: ErrorEnvelopeOptions = {},
): ApiErrorEnvelope {
  const body: ApiErrorBody = {
    code,
    message,
    requestId: ensureRequestId(requestId),
    retryable: options.retryable ?? false,
  };
  const details = sanitizeDetails(options.details);
  if (details !== undefined) {
    body.details = details;
  }
  if (options.capability !== undefined && options.capability !== '') {
    body.capability = options.capability;
  }
  return { ok: false, error: body };
}

// Typed error thrown by handlers and hooks. The global error handler in
// error-handler.ts converts it to an envelope with its status code.
// Handlers must only use fixed, generic messages: never interpolate
// user input, SQL, paths, or secret-adjacent values into the message.
// Machine-readable context belongs in details, and only when it is safe
// to send to the client.
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly capability?: string;

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
    this.capability = options.capability;
  }

  static validation(message = 'Request validation failed.', details?: unknown): ApiError {
    return new ApiError(400, 'VALIDATION_ERROR', message, { details });
  }

  static authRequired(message = 'Authentication is required.'): ApiError {
    return new ApiError(401, 'AUTH_REQUIRED', message);
  }

  static forbidden(message = 'Access is forbidden.'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static csrfFailed(message = 'Request verification failed.'): ApiError {
    return new ApiError(403, 'CSRF_FAILED', message);
  }

  static notFound(message = 'Resource not found.'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static conflict(message = 'Request conflicts with the current state.', details?: unknown): ApiError {
    return new ApiError(409, 'CONFLICT', message, { details });
  }

  static capabilityUnavailable(capability: string, message = 'This feature is not available in the web version.'): ApiError {
    return new ApiError(410, 'CAPABILITY_UNAVAILABLE', message, { capability });
  }

  static featureNotYetAvailable(message = 'This feature is not available yet in this version.'): ApiError {
    return new ApiError(501, 'FEATURE_NOT_YET_AVAILABLE', message);
  }

  static payloadTooLarge(message = 'Request payload is too large.'): ApiError {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', message);
  }

  static rateLimited(message = 'Too many requests.'): ApiError {
    return new ApiError(429, 'RATE_LIMITED', message, { retryable: true });
  }

  static serverError(message = 'Internal server error.'): ApiError {
    return new ApiError(500, 'SERVER_ERROR', message);
  }
}

interface FastifyLikeError {
  statusCode?: unknown;
  code?: unknown;
  validation?: unknown;
}

// Convert any thrown value to an HTTP status plus an envelope, without
// leaking the original message for unexpected errors. Fastify schema
// validation failures become VALIDATION_ERROR with a generic message;
// the field-level detail stays in the server log, not in the body.
export function toErrorEnvelope(error: unknown, requestId: string): { statusCode: number; envelope: ApiErrorEnvelope } {
  const id = ensureRequestId(requestId);
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      envelope: errorEnvelope(error.code, error.message, id, {
        retryable: error.retryable,
        details: error.details,
        capability: error.capability,
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
        envelope: errorEnvelope('VALIDATION_ERROR', 'Request validation failed.', id),
      };
    }
    if (statusCode === 413 || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return {
        statusCode: 413,
        envelope: errorEnvelope('PAYLOAD_TOO_LARGE', 'Request payload is too large.', id),
      };
    }
    if (statusCode === 404) {
      return {
        statusCode: 404,
        envelope: errorEnvelope('NOT_FOUND', 'Resource not found.', id),
      };
    }
    if (statusCode === 429) {
      return {
        statusCode: 429,
        envelope: errorEnvelope('RATE_LIMITED', 'Too many requests.', id, { retryable: true }),
      };
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return {
        statusCode,
        envelope: errorEnvelope('VALIDATION_ERROR', 'Request failed.', id),
      };
    }
  }
  return {
    statusCode: 500,
    envelope: errorEnvelope('SERVER_ERROR', 'Internal server error.', id),
  };
}
