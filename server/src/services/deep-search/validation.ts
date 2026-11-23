// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Pure validation for the Deep Search service (F2-2, wave G-F2-2a).
// Following the records K-09 contract: unknown fields are rejected,
// strings are trimmed, empty strings mean absent. The job input
// never carries a credential; there is no key field to accept.
//
// Decision enforcement (approved 23 Nov 2026):
// - Decision 1: the Exa ceiling is a per-job input. Without it the
//   Exa stage must not run. The initial ceiling is 0.15 USD per
//   job; a larger value is rejected until a new decision raises it.
// - Decision 6: at most 100 candidates per job.
// - Decision 10: Complement thresholds default to the binding
//   values (fact below 70, average below 80). Input may tighten
//   them (raise the bar), never loosen them.

import { ApiError } from '../../plugins/envelope.js';
import type { JobInput, StageChoice } from './represent.js';

export interface CreateJobInput {
  projectKey: string;
  topic: string;
  // Decimal string for the numeric column, or undefined when the
  // caller approved no Exa ceiling (PubMed-only job).
  budgetExaUsd: string | undefined;
  input: JobInput;
}

export const MAX_BUDGET_EXA_USD = 0.15;
export const MAX_CANDIDATES_LIMIT = 100;
export const DEFAULT_COMPLEMENT_THRESHOLD_FACT = 70;
export const DEFAULT_COMPLEMENT_THRESHOLD_AVERAGE = 80;

const MAX_PROJECT_KEY_LENGTH = 128;
const MAX_TOPIC_LENGTH = 2000;
const MAX_LANGUAGE_LENGTH = 35;

const CREATE_JOB_KEYS: ReadonlySet<string> = new Set([
  'projectKey',
  'topic',
  'maxCandidates',
  'budgetExaUsd',
  'yearFrom',
  'yearTo',
  'language',
  'stages',
  'complementThresholdFact',
  'complementThresholdAverage',
]);

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiError.validation('The request body must be an object.');
  }
  return body as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw ApiError.validation('The request body contains an unknown field.', { field: key });
    }
  }
}

function parseProjectKey(record: Record<string, unknown>): string {
  const value = record['projectKey'];
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.validation('The project key is required.', { field: 'projectKey' });
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_PROJECT_KEY_LENGTH) {
    throw ApiError.validation('The project key is too long.', { field: 'projectKey' });
  }
  return trimmed;
}

function parseTopic(record: Record<string, unknown>): string {
  const value = record['topic'];
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.validation('The topic is required.', { field: 'topic' });
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TOPIC_LENGTH) {
    throw ApiError.validation('The topic is too long.', { field: 'topic' });
  }
  return trimmed;
}

function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  message: string,
): number | undefined {
  const raw = record[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw ApiError.validation(message, { field: key });
  }
  return raw;
}

export function parseCreateJobBody(body: unknown): CreateJobInput {
  const record = asRecord(body);
  rejectUnknownKeys(record, CREATE_JOB_KEYS);
  const projectKey = parseProjectKey(record);
  const topic = parseTopic(record);

  const maxCandidates =
    optionalInteger(
      record,
      'maxCandidates',
      1,
      MAX_CANDIDATES_LIMIT,
      'The candidate cap must be an integer from 1 to 100.',
    ) ?? MAX_CANDIDATES_LIMIT;

  let budgetExaUsd: string | undefined;
  const rawBudget = record['budgetExaUsd'];
  if (rawBudget !== undefined && rawBudget !== null) {
    if (
      typeof rawBudget !== 'number' ||
      !Number.isFinite(rawBudget) ||
      rawBudget <= 0 ||
      rawBudget > MAX_BUDGET_EXA_USD
    ) {
      throw ApiError.validation('The Exa budget must be greater than 0 and at most 0.15 USD.', {
        field: 'budgetExaUsd',
      });
    }
    budgetExaUsd = rawBudget.toFixed(4);
  }

  const yearFrom = optionalInteger(record, 'yearFrom', 1000, 9999, 'The start year is not valid.');
  const yearTo = optionalInteger(record, 'yearTo', 1000, 9999, 'The end year is not valid.');
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    throw ApiError.validation('The start year must not exceed the end year.', {
      field: 'yearFrom',
    });
  }

  let language: string | undefined;
  const rawLanguage = record['language'];
  if (rawLanguage !== undefined && rawLanguage !== null) {
    if (typeof rawLanguage !== 'string') {
      throw ApiError.validation('A field has the wrong type.', { field: 'language' });
    }
    const trimmed = rawLanguage.trim();
    if (trimmed.length > MAX_LANGUAGE_LENGTH) {
      throw ApiError.validation('The language tag is too long.', { field: 'language' });
    }
    language = trimmed === '' ? undefined : trimmed;
  }

  let stages: StageChoice = 'full';
  const rawStages = record['stages'];
  if (rawStages !== undefined && rawStages !== null) {
    if (rawStages !== 'collector' && rawStages !== 'full') {
      throw ApiError.validation('The stage choice is not valid.', { field: 'stages' });
    }
    stages = rawStages;
  }

  // Tighten-only (decision 10): values below the binding defaults
  // would loosen the trigger and are rejected.
  const complementThresholdFact =
    optionalInteger(
      record,
      'complementThresholdFact',
      DEFAULT_COMPLEMENT_THRESHOLD_FACT,
      100,
      'The fact threshold may only tighten the default of 70.',
    ) ?? DEFAULT_COMPLEMENT_THRESHOLD_FACT;
  const complementThresholdAverage =
    optionalInteger(
      record,
      'complementThresholdAverage',
      DEFAULT_COMPLEMENT_THRESHOLD_AVERAGE,
      100,
      'The average threshold may only tighten the default of 80.',
    ) ?? DEFAULT_COMPLEMENT_THRESHOLD_AVERAGE;

  return {
    projectKey,
    topic,
    budgetExaUsd,
    input: {
      maxCandidates,
      yearFrom,
      yearTo,
      language,
      stages,
      complementThresholdFact,
      complementThresholdAverage,
    },
  };
}
