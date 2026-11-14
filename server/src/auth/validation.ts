// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Strict JSON body validation for auth endpoints (kontrak-api-kanonis.md
// section 1.5). Unknown fields are rejected with 400 validation_failed
// and details.fields naming each rejected field; wrong types are never
// guessed. Handlers collect every issue in one pass so a client sees
// all of its mistakes at once. V3-02 reuses these helpers for the
// advanced auth routes, so the field rules stay identical across the
// auth group.

import { ApiError } from '../plugins/envelope.js';

export interface FieldIssue {
  field: string;
  issue: string;
}

export function validationFailed(issues: FieldIssue[]): ApiError {
  return ApiError.validation('Request validation failed.', {
    fields: issues.map((entry) => ({ field: entry.field, issue: entry.issue })),
  });
}

export function throwIfIssues(issues: FieldIssue[]): void {
  if (issues.length > 0) {
    throw validationFailed(issues);
  }
}

// The request body must be a plain JSON object. Fastify delivers
// undefined when a POST carries no body; that is a validation failure
// for endpoints that require a body, not an empty object.
export function requireBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([{ field: 'body', issue: 'body must be a JSON object' }]);
  }
  return body as Record<string, unknown>;
}

export function unknownFieldIssues(body: Record<string, unknown>, allowed: readonly string[]): FieldIssue[] {
  const allowedSet = new Set(allowed);
  return Object.keys(body)
    .filter((key) => !allowedSet.has(key))
    .sort()
    .map((key) => ({ field: key, issue: 'unknown field' }));
}

// Reads a required string field. Returns undefined and records an
// issue when the field is missing, mistyped, or (unless allowEmpty)
// empty after trimming. The returned value is the raw string; callers
// that need normalization (email) apply it themselves.
export function requiredString(
  body: Record<string, unknown>,
  field: string,
  issues: FieldIssue[],
  options: { allowEmpty?: boolean; maxCodePoints?: number } = {},
): string | undefined {
  const value = body[field];
  if (typeof value !== 'string') {
    issues.push({ field, issue: `${field} must be a string` });
    return undefined;
  }
  if (value.includes('\0')) {
    issues.push({ field, issue: `${field} must not contain NUL` });
    return undefined;
  }
  if (options.allowEmpty !== true && value.trim() === '') {
    issues.push({ field, issue: `${field} must not be empty` });
    return undefined;
  }
  if (options.maxCodePoints !== undefined && [...value].length > options.maxCodePoints) {
    issues.push({ field, issue: `${field} must be at most ${options.maxCodePoints} characters` });
    return undefined;
  }
  return value;
}

// Reads an optional string field. Absent (undefined) yields undefined
// without an issue; a present value must be a string within bounds.
export function optionalString(
  body: Record<string, unknown>,
  field: string,
  issues: FieldIssue[],
  options: { maxCodePoints?: number; minTrimmedLength?: number } = {},
): string | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    issues.push({ field, issue: `${field} must be a string` });
    return undefined;
  }
  if (value.includes('\0')) {
    issues.push({ field, issue: `${field} must not contain NUL` });
    return undefined;
  }
  if (options.minTrimmedLength !== undefined && value.trim().length < options.minTrimmedLength) {
    issues.push({ field, issue: `${field} must not be empty` });
    return undefined;
  }
  if (options.maxCodePoints !== undefined && [...value].length > options.maxCodePoints) {
    issues.push({ field, issue: `${field} must be at most ${options.maxCodePoints} characters` });
    return undefined;
  }
  return value;
}
