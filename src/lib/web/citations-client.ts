// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Read-only citations client (F2-1 wave G-F2-1e, minimal UI). The
// single frontend path to the cookie-auth citations routes landed
// in G-F2-1b and the structured record read landed in G-F2-1b:
//
//   GET /api/citations/projects/:projectKey/references
//   GET /api/citations/projects/:projectKey/facts
//   GET /api/citations/projects/:projectKey/map
//   GET /api/records/structured/:markId
//
// Rules enforced here:
// - Read-only by design: this module exposes no create, map, or
//   patch call. The F2-1e panel only displays what the pipeline
//   already wrote through the API.
// - No ad hoc fetch: every request goes through ApiClient (V3-30),
//   same-origin, cookie credentials, envelope parsing, no retries.
// - No workspace identifier is ever sent; the workspace comes from
//   the session server-side (AD-08). Echoed workspaceId values in
//   responses are carried through untouched and never used for
//   paths.
// - Fail closed on malformed responses: a missing or mistyped
//   required field throws a local SERVER_ERROR instead of rendering
//   invented references or facts. A fact whose status is not
//   exactly "mapped" or "unmapped" is malformed, never guessed.
// - Unmapped facts never receive a marker (binding F2-1 rule). The
//   citation map only carries mapped facts; factMarkerNumbers
//   returns an empty list for anything absent from the map, and the
//   UI renders that as "no marker", never as a number.

import type { ApiClient } from "./api-client";
import { createLocalApiError } from "./errors";

export const CITATIONS_PROJECT_REFERENCES_PATH =
  "/api/citations/projects/:projectKey/references";
export const CITATIONS_PROJECT_FACTS_PATH =
  "/api/citations/projects/:projectKey/facts";
export const CITATIONS_PROJECT_MAP_PATH =
  "/api/citations/projects/:projectKey/map";
export const STRUCTURED_RECORD_PATH = "/api/records/structured/:markId";

// Mirrors MAX_PROJECT_KEY_LENGTH in server/src/routes/citations.ts.
export const CITATIONS_MAX_PROJECT_KEY_CHARS = 128;

export type CitationFactStatus = "mapped" | "unmapped";

/** Wire representation of one project reference (G-F2-1b). */
export interface CitationReference {
  id: string;
  workspaceId: string;
  projectKey: string;
  /** Null until first mapped to a fact; stable afterwards. */
  number: number | null;
  sourceRecordId: number | null;
  title: string | null;
  authors: string | null;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  oaFlag: boolean | null;
  createdAt: number;
  updatedAt: number;
}

/** Wire representation of one scored fact (G-F2-1b). */
export interface CitationFact {
  id: string;
  workspaceId: string;
  projectKey: string;
  text: string;
  score: number;
  status: CitationFactStatus;
  createdAt: number;
  updatedAt: number;
}

/** One citation-map entry: a mapped fact and its sorted numbers. */
export interface CitationMapEntry {
  factId: string;
  numbers: number[];
}

/** Bibliographic companion row of one record (G-F2-1b). */
export interface MarkBibliography {
  markId: number;
  workspaceId: string;
  title: string | null;
  authors: string | null;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  oaFlag: boolean | null;
  createdAt: number;
  updatedAt: number;
}

export interface CitationsRequestOptions {
  /** Caller abort signal. Aborting produces a TIMEOUT ApiError. */
  signal?: AbortSignal;
}

/**
 * Normalize raw project-key input to the wire value: trimmed,
 * 1-128 characters. Returns null when the input cannot be sent
 * (empty, whitespace-only, overlong, or not a string). The UI
 * treats null as "no project selected", never as a request for an
 * empty project key.
 */
export function normalizeProjectKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > CITATIONS_MAX_PROJECT_KEY_CHARS) {
    return null;
  }
  return trimmed;
}

function projectPath(template: string, projectKey: string): string {
  return template.replace(":projectKey", encodeURIComponent(projectKey));
}

/**
 * Display order for references: numbered first by number
 * ascending, then unnumbered by creation order. Mirrors the
 * server sort (represent.ts sortReferences); the server already
 * returns this order, and this helper only keeps the panel honest
 * if a caller passes an unsorted list. It never renumbers.
 */
export function sortCitationReferences(
  rows: CitationReference[],
): CitationReference[] {
  return [...rows].sort((a, b) => {
    if (a.number !== null && b.number !== null) return a.number - b.number;
    if (a.number !== null) return -1;
    if (b.number !== null) return 1;
    return a.createdAt - b.createdAt;
  });
}

/**
 * Marker numbers for one fact from the citation map. A fact absent
 * from the map (every unmapped fact, by rule) returns an empty
 * list; callers must render that as no marker, never as a number.
 */
export function factMarkerNumbers(
  entries: CitationMapEntry[],
  factId: string,
): number[] {
  const entry = entries.find((item) => item.factId === factId);
  return entry === undefined ? [] : [...entry.numbers];
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

function parseReference(value: unknown): CitationReference | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.projectKey !== "string" ||
    !isNullableNumber(value.number) ||
    !isNullableNumber(value.sourceRecordId) ||
    !isNullableString(value.title) ||
    !isNullableString(value.authors) ||
    !isNullableString(value.journal) ||
    !isNullableNumber(value.year) ||
    !isNullableString(value.doi) ||
    !isNullableString(value.pmid) ||
    !isNullableString(value.pmcid) ||
    !isNullableString(value.url) ||
    !isNullableBoolean(value.oaFlag) ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    projectKey: value.projectKey,
    number: value.number,
    sourceRecordId: value.sourceRecordId,
    title: value.title,
    authors: value.authors,
    journal: value.journal,
    year: value.year,
    doi: value.doi,
    pmid: value.pmid,
    pmcid: value.pmcid,
    url: value.url,
    oaFlag: value.oaFlag,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseFact(value: unknown): CitationFact | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.projectKey !== "string" ||
    typeof value.text !== "string" ||
    !isFiniteNumber(value.score) ||
    (value.status !== "mapped" && value.status !== "unmapped") ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    projectKey: value.projectKey,
    text: value.text,
    score: value.score,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseMapEntry(value: unknown): CitationMapEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.factId !== "string" ||
    !Array.isArray(value.numbers) ||
    value.numbers.some((entry) => !isFiniteNumber(entry))
  ) {
    return null;
  }
  return { factId: value.factId, numbers: [...(value.numbers as number[])] };
}

function parseBibliography(value: unknown): MarkBibliography | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isFiniteNumber(value.markId) ||
    typeof value.workspaceId !== "string" ||
    !isNullableString(value.title) ||
    !isNullableString(value.authors) ||
    !isNullableString(value.journal) ||
    !isNullableNumber(value.year) ||
    !isNullableString(value.doi) ||
    !isNullableString(value.pmid) ||
    !isNullableString(value.pmcid) ||
    !isNullableString(value.url) ||
    !isNullableBoolean(value.oaFlag) ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return null;
  }
  return {
    markId: value.markId,
    workspaceId: value.workspaceId,
    title: value.title,
    authors: value.authors,
    journal: value.journal,
    year: value.year,
    doi: value.doi,
    pmid: value.pmid,
    pmcid: value.pmcid,
    url: value.url,
    oaFlag: value.oaFlag,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseItems<T>(
  data: unknown,
  parse: (value: unknown) => T | null,
): T[] {
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

function requireProjectKey(value: unknown): string {
  const projectKey = normalizeProjectKey(value);
  if (projectKey === null) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  return projectKey;
}

/** All references of one project, in server display order. */
export async function getProjectReferences(
  client: ApiClient,
  projectKeyInput: string,
  options: CitationsRequestOptions = {},
): Promise<CitationReference[]> {
  const projectKey = requireProjectKey(projectKeyInput);
  const data = await client.getJson<unknown>(
    projectPath(CITATIONS_PROJECT_REFERENCES_PATH, projectKey),
    { signal: options.signal },
  );
  return parseItems(data, parseReference);
}

/** All facts of one project, creation order, with mapped status. */
export async function getProjectFacts(
  client: ApiClient,
  projectKeyInput: string,
  options: CitationsRequestOptions = {},
): Promise<CitationFact[]> {
  const projectKey = requireProjectKey(projectKeyInput);
  const data = await client.getJson<unknown>(
    projectPath(CITATIONS_PROJECT_FACTS_PATH, projectKey),
    { signal: options.signal },
  );
  return parseItems(data, parseFact);
}

/** The citation map of one project (mapped facts only, by rule). */
export async function getProjectCitationMap(
  client: ApiClient,
  projectKeyInput: string,
  options: CitationsRequestOptions = {},
): Promise<CitationMapEntry[]> {
  const projectKey = requireProjectKey(projectKeyInput);
  const data = await client.getJson<unknown>(
    projectPath(CITATIONS_PROJECT_MAP_PATH, projectKey),
    { signal: options.signal },
  );
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    throw createLocalApiError("SERVER_ERROR");
  }
  const entries: CitationMapEntry[] = [];
  for (const entry of data.entries) {
    const parsed = parseMapEntry(entry);
    if (parsed === null) {
      throw createLocalApiError("SERVER_ERROR");
    }
    entries.push(parsed);
  }
  return entries;
}

/**
 * The bibliographic companion row of one record, or null when the
 * record has none. Reads the structured record endpoint and
 * returns only its bibliography part; an unknown record answers
 * the server 404 as an ApiError, never a null bibliography.
 */
export async function getRecordBibliography(
  client: ApiClient,
  markId: number,
  options: CitationsRequestOptions = {},
): Promise<MarkBibliography | null> {
  if (!Number.isSafeInteger(markId) || markId <= 0) {
    throw createLocalApiError("VALIDATION_ERROR");
  }
  const data = await client.getJson<unknown>(
    STRUCTURED_RECORD_PATH.replace(":markId", String(markId)),
    { signal: options.signal },
  );
  if (!isRecord(data) || !("bibliography" in data)) {
    throw createLocalApiError("SERVER_ERROR");
  }
  if (data.bibliography === null) {
    return null;
  }
  const parsed = parseBibliography(data.bibliography);
  if (parsed === null) {
    throw createLocalApiError("SERVER_ERROR");
  }
  return parsed;
}
