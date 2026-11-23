// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Deep Search client (F2-2 wave G-F2-2f, minimal UI). The single
// frontend path to the cookie-auth Deep Search job routes landed
// in G-F2-2a..e:
//
//   POST /api/deep-search/jobs
//   GET  /api/deep-search/jobs
//   GET  /api/deep-search/jobs/:jobId
//   GET  /api/deep-search/jobs/:jobId/candidates
//   GET  /api/deep-search/jobs/:jobId/facts
//   POST /api/deep-search/jobs/:jobId/cancel
//   POST /api/deep-search/jobs/:jobId/retry
//   POST /api/deep-search/jobs/:jobId/approve-writing
//
// Rules enforced here:
// - No ad hoc fetch: every request goes through ApiClient (V3-30),
//   same-origin, cookie credentials, envelope parsing, no retries.
// - No workspace identifier is ever sent; the workspace comes from
//   the session server-side (AD-08).
// - No credential field exists in the create input; the Exa key and
//   the E-utilities identity live in server config only (design
//   3.4). The create body never carries writingApproved: approval
//   is the separate approve-writing call (decision 8), and the
//   server rejects the field in the create body.
// - Fail closed on malformed responses: a missing or mistyped
//   required field throws a local SERVER_ERROR instead of
//   rendering invented jobs, candidates, or scores. A job status,
//   step status, disposition, or fact status outside the server
//   vocabulary is malformed, never guessed.
// - Local input validation mirrors the server bounds (project key
//   1-128 chars, topic required, candidate cap 1-100, Exa budget
//   at most 0.15 USD) so the panel can fail fast; the server stays
//   the authority and its 400 answers surface as ApiErrors.

import type { ApiClient } from "./api-client";
import { createLocalApiError } from "./errors";

export const DEEP_SEARCH_JOBS_PATH = "/api/deep-search/jobs";
export const DEEP_SEARCH_JOB_PATH = "/api/deep-search/jobs/:jobId";
export const DEEP_SEARCH_JOB_CANDIDATES_PATH = "/api/deep-search/jobs/:jobId/candidates";
export const DEEP_SEARCH_JOB_FACTS_PATH = "/api/deep-search/jobs/:jobId/facts";
export const DEEP_SEARCH_JOB_CANCEL_PATH = "/api/deep-search/jobs/:jobId/cancel";
export const DEEP_SEARCH_JOB_RETRY_PATH = "/api/deep-search/jobs/:jobId/retry";
export const DEEP_SEARCH_JOB_APPROVE_WRITING_PATH =
  "/api/deep-search/jobs/:jobId/approve-writing";

// Mirrors the server bounds in services/deep-search/validation.ts.
export const DEEP_SEARCH_MAX_PROJECT_KEY_CHARS = 128;
export const DEEP_SEARCH_MAX_TOPIC_CHARS = 2000;
export const DEEP_SEARCH_MAX_CANDIDATES = 100;
export const DEEP_SEARCH_MAX_BUDGET_EXA_USD = 0.15;

export type DeepSearchJobStatus =
  | "queued"
  | "collecting"
  | "assessing"
  | "complementing"
  | "writing"
  | "completed"
  | "failed"
  | "cancelled";

export type DeepSearchStepKind =
  | "collector_pubmed"
  | "collector_exa"
  | "assessor"
  | "complement";

export type DeepSearchStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed";

export type DeepSearchSourceKind = "pubmed" | "europepmc" | "exa";

export type DeepSearchCandidateDisposition =
  | "pending"
  | "accepted"
  | "duplicate"
  | "rejected";

export type DeepSearchFactCandidateStatus = "pending" | "mapped" | "unmapped";

export type DeepSearchStageChoice = "collector" | "full";

const JOB_STATUSES: readonly string[] = [
  "queued",
  "collecting",
  "assessing",
  "complementing",
  "writing",
  "completed",
  "failed",
  "cancelled",
];

const STEP_KINDS: readonly string[] = [
  "collector_pubmed",
  "collector_exa",
  "assessor",
  "complement",
];

const STEP_STATUSES: readonly string[] = [
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
];

const SOURCE_KINDS: readonly string[] = ["pubmed", "europepmc", "exa"];

const CANDIDATE_DISPOSITIONS: readonly string[] = [
  "pending",
  "accepted",
  "duplicate",
  "rejected",
];

const FACT_CANDIDATE_STATUSES: readonly string[] = ["pending", "mapped", "unmapped"];

/** Wire representation of one Deep Search job (G-F2-2a). */
export interface DeepSearchJob {
  id: string;
  workspaceId: string;
  projectKey: string;
  topic: string;
  status: DeepSearchJobStatus;
  input: {
    maxCandidates: number;
    yearFrom: number | null;
    yearTo: number | null;
    language: string | null;
    stages: DeepSearchStageChoice;
    complementThresholdFact: number;
    complementThresholdAverage: number;
    writingApproved: boolean;
  };
  budgetExaUsd: string | null;
  costExaUsd: string;
  createdByUserId: string | null;
  createdByTokenId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  errorCode: string | null;
  errorDetail: string | null;
}

/** Wire representation of one job stage row (G-F2-2a). */
export interface DeepSearchJobStep {
  id: string;
  jobId: string;
  step: DeepSearchStepKind;
  status: DeepSearchStepStatus;
  detail: Record<string, unknown> | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Candidate/fact counts of one job (G-F2-2a). */
export interface DeepSearchJobSummary {
  candidates: number;
  acceptedCandidates: number;
  factCandidates: number;
  mappedFacts: number;
  unmappedFacts: number;
}

/** Wire representation of one collected candidate (G-F2-2b/c). */
export interface DeepSearchCandidate {
  id: string;
  jobId: string;
  sourceKind: DeepSearchSourceKind;
  externalId: string;
  title: string | null;
  authors: string | null;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  oaFlag: boolean | null;
  snippet: string | null;
  disposition: DeepSearchCandidateDisposition;
  rejectReason: string | null;
  recordMarkId: number | null;
  createdAt: number;
}

/** Wire representation of one scored fact candidate (G-F2-2d). */
export interface DeepSearchFactCandidate {
  id: string;
  jobId: string;
  text: string;
  score: number | null;
  status: DeepSearchFactCandidateStatus;
  factId: string | null;
  assessorNote: string | null;
  createdAt: number;
}

/** Job detail: the job, its stage rows, and its counts. */
export interface DeepSearchJobDetail {
  job: DeepSearchJob;
  steps: DeepSearchJobStep[];
  summary: DeepSearchJobSummary;
}

/** Create-job input accepted by this client (server validates). */
export interface CreateDeepSearchJobInput {
  projectKey: string;
  topic: string;
  maxCandidates?: number;
  budgetExaUsd?: number;
  yearFrom?: number;
  yearTo?: number;
  language?: string;
  stages?: DeepSearchStageChoice;
}

export interface DeepSearchRequestOptions {
  /** Caller abort signal. Aborting produces a TIMEOUT ApiError. */
  signal?: AbortSignal;
}

/**
 * Normalize raw project-key input to the wire value: trimmed,
 * 1-128 characters. Returns null when the input cannot be sent.
 */
export function normalizeDeepSearchProjectKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > DEEP_SEARCH_MAX_PROJECT_KEY_CHARS) {
    return null;
  }
  return trimmed;
}

/**
 * Validate create-job input locally against the server bounds.
 * Returns the wire body, or null when the input cannot be sent.
 * Optional fields are omitted, never sent as empty values.
 */
export function buildCreateJobBody(
  input: CreateDeepSearchJobInput,
): Record<string, unknown> | null {
  const projectKey = normalizeDeepSearchProjectKey(input.projectKey);
  if (projectKey === null) {
    return null;
  }
  if (typeof input.topic !== "string") {
    return null;
  }
  const topic = input.topic.trim();
  if (topic === "" || topic.length > DEEP_SEARCH_MAX_TOPIC_CHARS) {
    return null;
  }
  const body: Record<string, unknown> = { projectKey, topic };
  if (input.maxCandidates !== undefined) {
    if (
      !Number.isInteger(input.maxCandidates) ||
      input.maxCandidates < 1 ||
      input.maxCandidates > DEEP_SEARCH_MAX_CANDIDATES
    ) {
      return null;
    }
    body.maxCandidates = input.maxCandidates;
  }
  if (input.budgetExaUsd !== undefined) {
    if (
      typeof input.budgetExaUsd !== "number" ||
      !Number.isFinite(input.budgetExaUsd) ||
      input.budgetExaUsd <= 0 ||
      input.budgetExaUsd > DEEP_SEARCH_MAX_BUDGET_EXA_USD
    ) {
      return null;
    }
    body.budgetExaUsd = input.budgetExaUsd;
  }
  for (const key of ["yearFrom", "yearTo"] as const) {
    const year = input[key];
    if (year !== undefined) {
      if (!Number.isInteger(year) || year < 1000 || year > 9999) {
        return null;
      }
      body[key] = year;
    }
  }
  if (
    typeof body.yearFrom === "number" &&
    typeof body.yearTo === "number" &&
    body.yearFrom > body.yearTo
  ) {
    return null;
  }
  if (input.language !== undefined) {
    const language = input.language.trim();
    if (language.length > 35) {
      return null;
    }
    if (language !== "") {
      body.language = language;
    }
  }
  if (input.stages !== undefined) {
    if (input.stages !== "collector" && input.stages !== "full") {
      return null;
    }
    body.stages = input.stages;
  }
  return body;
}

/** True while the job can still move (not completed/failed/cancelled). */
export function isDeepSearchJobActive(job: DeepSearchJob): boolean {
  return (
    job.status === "queued" ||
    job.status === "collecting" ||
    job.status === "assessing" ||
    job.status === "complementing" ||
    job.status === "writing"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function parseJob(value: unknown): DeepSearchJob | null {
  if (!isRecord(value) || !isRecord(value.input)) {
    return null;
  }
  const input = value.input;
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.projectKey !== "string" ||
    typeof value.topic !== "string" ||
    typeof value.status !== "string" ||
    !JOB_STATUSES.includes(value.status) ||
    !isFiniteNumber(input.maxCandidates) ||
    !isNullableNumber(input.yearFrom) ||
    !isNullableNumber(input.yearTo) ||
    !isNullableString(input.language) ||
    (input.stages !== "collector" && input.stages !== "full") ||
    !isFiniteNumber(input.complementThresholdFact) ||
    !isFiniteNumber(input.complementThresholdAverage) ||
    typeof input.writingApproved !== "boolean" ||
    !isNullableString(value.budgetExaUsd) ||
    typeof value.costExaUsd !== "string" ||
    !isNullableString(value.createdByUserId) ||
    !isNullableString(value.createdByTokenId) ||
    !isFiniteNumber(value.createdAt) ||
    !isNullableNumber(value.startedAt) ||
    !isNullableNumber(value.finishedAt) ||
    !isNullableString(value.errorCode) ||
    !isNullableString(value.errorDetail)
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    projectKey: value.projectKey,
    topic: value.topic,
    status: value.status as DeepSearchJobStatus,
    input: {
      maxCandidates: input.maxCandidates,
      yearFrom: input.yearFrom,
      yearTo: input.yearTo,
      language: input.language,
      stages: input.stages,
      complementThresholdFact: input.complementThresholdFact,
      complementThresholdAverage: input.complementThresholdAverage,
      writingApproved: input.writingApproved,
    },
    budgetExaUsd: value.budgetExaUsd,
    costExaUsd: value.costExaUsd,
    createdByUserId: value.createdByUserId,
    createdByTokenId: value.createdByTokenId,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    errorCode: value.errorCode,
    errorDetail: value.errorDetail,
  };
}

function parseJobStep(value: unknown): DeepSearchJobStep | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.jobId !== "string" ||
    typeof value.step !== "string" ||
    !STEP_KINDS.includes(value.step) ||
    typeof value.status !== "string" ||
    !STEP_STATUSES.includes(value.status) ||
    (value.detail !== null && !isRecord(value.detail)) ||
    !isNullableNumber(value.startedAt) ||
    !isNullableNumber(value.finishedAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    jobId: value.jobId,
    step: value.step as DeepSearchStepKind,
    status: value.status as DeepSearchStepStatus,
    detail: value.detail,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
  };
}

function parseJobSummary(value: unknown): DeepSearchJobSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isFiniteNumber(value.candidates) ||
    !isFiniteNumber(value.acceptedCandidates) ||
    !isFiniteNumber(value.factCandidates) ||
    !isFiniteNumber(value.mappedFacts) ||
    !isFiniteNumber(value.unmappedFacts)
  ) {
    return null;
  }
  return {
    candidates: value.candidates,
    acceptedCandidates: value.acceptedCandidates,
    factCandidates: value.factCandidates,
    mappedFacts: value.mappedFacts,
    unmappedFacts: value.unmappedFacts,
  };
}

function parseCandidate(value: unknown): DeepSearchCandidate | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.jobId !== "string" ||
    typeof value.sourceKind !== "string" ||
    !SOURCE_KINDS.includes(value.sourceKind) ||
    typeof value.externalId !== "string" ||
    !isNullableString(value.title) ||
    !isNullableString(value.authors) ||
    !isNullableString(value.journal) ||
    !isNullableNumber(value.year) ||
    !isNullableString(value.doi) ||
    !isNullableString(value.pmid) ||
    !isNullableString(value.pmcid) ||
    !isNullableString(value.url) ||
    !isNullableBoolean(value.oaFlag) ||
    !isNullableString(value.snippet) ||
    typeof value.disposition !== "string" ||
    !CANDIDATE_DISPOSITIONS.includes(value.disposition) ||
    !isNullableString(value.rejectReason) ||
    !isNullableNumber(value.recordMarkId) ||
    !isFiniteNumber(value.createdAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    jobId: value.jobId,
    sourceKind: value.sourceKind as DeepSearchSourceKind,
    externalId: value.externalId,
    title: value.title,
    authors: value.authors,
    journal: value.journal,
    year: value.year,
    doi: value.doi,
    pmid: value.pmid,
    pmcid: value.pmcid,
    url: value.url,
    oaFlag: value.oaFlag,
    snippet: value.snippet,
    disposition: value.disposition as DeepSearchCandidateDisposition,
    rejectReason: value.rejectReason,
    recordMarkId: value.recordMarkId,
    createdAt: value.createdAt,
  };
}

function parseFactCandidate(value: unknown): DeepSearchFactCandidate | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.jobId !== "string" ||
    typeof value.text !== "string" ||
    !isNullableNumber(value.score) ||
    typeof value.status !== "string" ||
    !FACT_CANDIDATE_STATUSES.includes(value.status) ||
    !isNullableString(value.factId) ||
    !isNullableString(value.assessorNote) ||
    !isFiniteNumber(value.createdAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    jobId: value.jobId,
    text: value.text,
    score: value.score,
    status: value.status as DeepSearchFactCandidateStatus,
    factId: value.factId,
    assessorNote: value.assessorNote,
    createdAt: value.createdAt,
  };
}

function parseItems<T>(data: unknown, parse: (value: unknown) => T | null): T[] {
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw createLocalApiError("SERVER_ERROR");
  }
  const items: T[] = [];
  for (const entry of data.items) {
    const parsed = parse(entry);
    if (parsed === null) {
      throw createLocalApiError("SERVER_ERROR");
    }
    items.push(parsed);
  }
  return items;
}

function parseJobOrThrow(data: unknown): DeepSearchJob {
  const parsed = parseJob(data);
  if (parsed === null) {
    throw createLocalApiError("SERVER_ERROR");
  }
  return parsed;
}

function jobPath(template: string, jobId: string): string {
  if (typeof jobId !== "string" || jobId.trim() === "") {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  return template.replace(":jobId", encodeURIComponent(jobId.trim()));
}

/** Create one Deep Search job. Answers the queued job (202). */
export async function createDeepSearchJob(
  client: ApiClient,
  input: CreateDeepSearchJobInput,
  options: DeepSearchRequestOptions = {},
): Promise<DeepSearchJob> {
  const body = buildCreateJobBody(input);
  if (body === null) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  const data = await client.postJson<unknown>(DEEP_SEARCH_JOBS_PATH, body, {
    signal: options.signal,
  });
  return parseJobOrThrow(data);
}

/** Jobs of the workspace, newest first, optionally per project. */
export async function listDeepSearchJobs(
  client: ApiClient,
  filter: { projectKey?: string; status?: DeepSearchJobStatus; limit?: number } = {},
  options: DeepSearchRequestOptions = {},
): Promise<DeepSearchJob[]> {
  const params = new URLSearchParams();
  if (filter.projectKey !== undefined) {
    const projectKey = normalizeDeepSearchProjectKey(filter.projectKey);
    if (projectKey === null) {
      throw createLocalApiError("VALIDATION_ERROR");
    }
    params.set("projectKey", projectKey);
  }
  if (filter.status !== undefined) {
    if (!JOB_STATUSES.includes(filter.status)) {
      throw createLocalApiError("VALIDATION_ERROR");
    }
    params.set("status", filter.status);
  }
  if (filter.limit !== undefined) {
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 100) {
      throw createLocalApiError("VALIDATION_ERROR");
    }
    params.set("limit", String(filter.limit));
  }
  const query = params.toString();
  const data = await client.getJson<unknown>(
    query === "" ? DEEP_SEARCH_JOBS_PATH : `${DEEP_SEARCH_JOBS_PATH}?${query}`,
    { signal: options.signal },
  );
  return parseItems(data, parseJob);
}

/** One job with its stage rows and counts. */
export async function getDeepSearchJob(
  client: ApiClient,
  jobId: string,
  options: DeepSearchRequestOptions = {},
): Promise<DeepSearchJobDetail> {
  const data = await client.getJson<unknown>(jobPath(DEEP_SEARCH_JOB_PATH, jobId), {
    signal: options.signal,
  });
  if (!isRecord(data) || !Array.isArray(data.steps)) {
    throw createLocalApiError("SERVER_ERROR");
  }
  const job = parseJobOrThrow(data.job);
  const summary = parseJobSummary(data.summary);
  if (summary === null) {
    throw createLocalApiError("SERVER_ERROR");
  }
  const steps: DeepSearchJobStep[] = [];
  for (const entry of data.steps) {
    const parsed = parseJobStep(entry);
    if (parsed === null) {
      throw createLocalApiError("SERVER_ERROR");
    }
    steps.push(parsed);
  }
  return { job, steps, summary };
}

/** Collected candidates of one job, creation order. */
export async function listDeepSearchCandidates(
  client: ApiClient,
  jobId: string,
  options: DeepSearchRequestOptions = {},
): Promise<DeepSearchCandidate[]> {
  const data = await client.getJson<unknown>(
    jobPath(DEEP_SEARCH_JOB_CANDIDATES_PATH, jobId),
    { signal: options.signal },
  );
  return parseItems(data, parseCandidate);
}

/** Scored fact candidates of one job, creation order. */
export async function listDeepSearchFactCandidates(
  client: ApiClient,
  jobId: string,
  options: DeepSearchRequestOptions = {},
): Promise<DeepSearchFactCandidate[]> {
  const data = await client.getJson<unknown>(jobPath(DEEP_SEARCH_JOB_FACTS_PATH, jobId), {
    signal: options.signal,
  });
  return parseItems(data, parseFactCandidate);
}

/** Cancel a job before writing (server answers 409 otherwise). */
export async function cancelDeepSearchJob(
  client: ApiClient,
  jobId: string,
  options: DeepSearchRequestOptions = {},
): Promise<DeepSearchJob> {
  const data = await client.postJson<unknown>(
    jobPath(DEEP_SEARCH_JOB_CANCEL_PATH, jobId),
    undefined,
    { signal: options.signal },
  );
  return parseJobOrThrow(data);
}

/** Retry a failed job (server answers 409 from any other status). */
export async function retryDeepSearchJob(
  client: ApiClient,
  jobId: string,
  options: DeepSearchRequestOptions = {},
): Promise<DeepSearchJob> {
  const data = await client.postJson<unknown>(
    jobPath(DEEP_SEARCH_JOB_RETRY_PATH, jobId),
    undefined,
    { signal: options.signal },
  );
  return parseJobOrThrow(data);
}

/**
 * The explicit human approval that lets the first job of a
 * project write into F2-1 (decision 8). Never sent implicitly:
 * only the panel button calls this.
 */
export async function approveDeepSearchWriting(
  client: ApiClient,
  jobId: string,
  options: DeepSearchRequestOptions = {},
): Promise<DeepSearchJob> {
  const data = await client.postJson<unknown>(
    jobPath(DEEP_SEARCH_JOB_APPROVE_WRITING_PATH, jobId),
    undefined,
    { signal: options.signal },
  );
  return parseJobOrThrow(data);
}
