// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// POST /api/csp-reports: browser CSP violation reports.
//
// Contract: kontrak-api-kanonis.md section 3.11 (204 empty, no
// session, strict rate limit, report URLs cleaned of query and token,
// no sensitive data stored) and section 2.3 (no envelope: this is a
// browser reporting protocol, not a JSON API call). Design: V1-17
// section 4 (report-uri / report-to row). The CSP directive values
// themselves (O-07) are decided by the hardening wave; this module
// only receives reports and sets no CSP header of any kind.
//
// No session: browsers send reports without application credentials.
// The global auth hook exempts exactly this POST path
// (middleware/auth-hook.ts: CSP_REPORT_PATH and
// isPublicNoSessionRequest). This route deliberately carries no
// requiresAuth config, so the frozen hook exemption is the mechanism
// and is exercised by the integration tests. No CSRF token and no
// Origin check apply here; the report body is untrusted input from
// any browser, so everything below treats it as hostile.
//
// Accepted shapes (both are real browser wire formats):
// 1. Legacy CSP Level 2: a JSON object with a "csp-report" object
//    (Content-Type application/csp-report). Field names are
//    kebab-case: document-uri, referrer, violated-directive,
//    effective-directive, original-policy, disposition, blocked-uri,
//    line-number, column-number, source-file, status-code,
//    script-sample.
// 2. Reporting API: a JSON array of report objects, or a single
//    report object (Content-Type application/reports+json, also
//    accepted as application/json). Each report has a "body" object
//    with camelCase fields: documentURL, referrer,
//    violatedDirective, effectiveDirective, originalPolicy,
//    disposition, blockedURL, lineNumber, columnNumber, sourceFile,
//    statusCode, sample. The top-level "type" must be
//    "csp-violation" when present, and the top-level "url" may stand
//    in for a missing body documentURL.
//
// Validation: a report is valid only when it names the document
// (document-uri / documentURL, or the Reporting API top-level url)
// and names at least one directive (violated or effective). Known
// fields with the wrong type, out of range numbers, or overlong
// strings answer 400 validation_failed with details.fields naming
// the fields and the issue, never echoing values. Unknown fields are
// DROPPED, not rejected and never logged: this is a deliberate,
// documented exception to the contract rule that rejects unknown
// JSON fields (K-09), because browsers add report fields over time
// and an unknown field is the most likely place for a leaked token
// to hide. Malformed JSON answers 400 invalid_json through the
// global error handler; a body over the route limit answers 413
// payload_too_large.
//
// Sanitization rules (every logged value passes through these; the
// raw body is never logged and never stored):
// 1. Allowlist only: the logged record contains exactly the known
//    fields listed above, renamed to one canonical camelCase shape.
//    Unknown fields, cookies, headers, and the client IP are never
//    logged.
// 2. URL fields (document, referrer, blocked, source file) keep
//    only scheme, host, and path. Query strings, fragments, and
//    userinfo are removed entirely, so a token in "?token=..." can
//    never reach the log. Non-HTTP(S) URLs keep only their scheme
//    (for example "data:"). Only the bare spec keywords "inline"
//    and "eval" pass through unchanged; any other bare value is
//    redacted, so a raw token or JWT sent as a bare blocked-uri
//    cannot reach the log either. A value that does not parse as a
//    URL becomes the literal "[redacted]". Long path segments that
//    look like tokens are replaced per segment, and a key=value
//    secret embedded in a path is redacted as a last step.
// 3. Policy and sample strings pass through redactSensitiveText:
//    Bearer tokens, key=value pairs for token, secret, password,
//    api key, and session names, nonce and hash tokens inside a
//    policy, and any remaining run of 32 or more token characters
//    are replaced with "[redacted]". Samples are truncated to 200
//    characters after redaction.
// 4. Numbers pass through only after type and range checks.
// 5. Nothing is persisted: reports go to the structured log only
//    (request.log.warn with one sanitized record per report). There
//    is no database write, no file write, and no echo in any
//    response.
//
// Rate limit: a route-local fixed window, 30 reports per minute per
// client IP, because no global rate-limit middleware exists yet
// (foundation handoff item 3; owned by the auth worker). The limit
// is deliberately stricter than the canonical 60 per minute per IP
// for sessionless traffic, so one misbehaving reporter cannot flood
// the log. Rejected reports answer 429 rate_limited with a
// Retry-After header and are not logged at all. The limiter keeps
// at most 1000 tracked IPs and prunes expired windows on every
// check, so its memory stays bounded. When the global middleware
// lands, it may supersede this local limiter; the local values are
// recorded in the wave 3 report for the runbook.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CSP_REPORT_PATH } from '../middleware/auth-hook.js';
import { ApiError, errorEnvelope } from '../plugins/envelope.js';

// Route body limit: browser reports are small (well under 4 KiB in
// practice). 16 KiB leaves ample headroom and bounds parse cost.
export const CSP_REPORT_BODY_LIMIT_BYTES = 16384;
export const CSP_REPORT_RATE_LIMIT_MAX = 30;
export const CSP_REPORT_RATE_LIMIT_WINDOW_MS = 60000;
export const CSP_REPORT_RATE_LIMIT_MAX_IPS = 1000;
export const CSP_REPORT_MAX_REPORTS_PER_REQUEST = 10;
export const CSP_REPORT_MAX_URL_LENGTH = 2048;
export const CSP_REPORT_MAX_POLICY_LENGTH = 8192;
export const CSP_REPORT_MAX_DIRECTIVE_LENGTH = 128;
export const CSP_REPORT_MAX_SAMPLE_LOG_LENGTH = 200;

const REPORTING_API_TYPES = ['application/csp-report', 'application/reports+json'] as const;

// One canonical logged shape, whatever wire format arrived. Only
// fields present in the input appear in the output.
export interface SanitizedCspReport {
  format: 'csp-report' | 'reporting-api';
  documentUri: string;
  referrer?: string;
  violatedDirective?: string;
  effectiveDirective?: string;
  originalPolicy?: string;
  disposition?: string;
  blockedUri?: string;
  lineNumber?: number;
  columnNumber?: number;
  sourceFile?: string;
  statusCode?: number;
  sample?: string;
}

export interface CspReportValidationIssue {
  field: string;
  issue: string;
}

export type CspReportParseResult =
  | { ok: true; reports: SanitizedCspReport[] }
  | { ok: false; issues: CspReportValidationIssue[] };

const BARE_BLOCKED_KEYWORDS = new Set(['inline', 'eval']);
const TOKEN_RUN = /[A-Za-z0-9._~-]{32,}/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const SENSITIVE_KEY_VALUE =
  /\b(token|api[-_]?key|apikey|secret|password|passwd|pwd|authorization|access[-_]?token|refresh[-_]?token|session[-_]?id|session|client[-_]?secret)\s*[:=]\s*(?!Bearer\b)[^\s&'";,]+/gi;
const POLICY_NONCE_OR_HASH = /'(nonce|sha256|sha384|sha512)-[^']*'/gi;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

// Redact token-like material from a free-text string (policy or
// sample). Order matters: nonce/hash tokens first, then Bearer,
// then key=value pairs, then any remaining long token run.
export function redactSensitiveText(value: string): string {
  let out = stripControlChars(value);
  out = out.replace(POLICY_NONCE_OR_HASH, (_match, kind: string) => `'${kind}-[redacted]'`);
  out = out.replace(BEARER_TOKEN, 'Bearer [redacted]');
  out = out.replace(SENSITIVE_KEY_VALUE, (_match, key: string) => `${key}=[redacted]`);
  out = out.replace(TOKEN_RUN, '[redacted]');
  return out;
}

function redactLongPathSegments(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (segment.length >= 32 && /^[A-Za-z0-9._~-]+$/.test(segment) ? '[redacted]' : segment))
    .join('/');
}

// Keep only scheme, host, and path of a URL. Query, fragment, and
// userinfo are dropped. Non-HTTP(S) URLs keep only the scheme, so a
// data: or blob: payload can never leak into the log. Unparseable
// values become "[redacted]". Only the two bare keywords the CSP
// spec allows for blocked-uri ("inline", "eval") pass through; any
// other bare value (a raw token, a JWT, a bare hostname) fails the
// URL parse below and becomes "[redacted]", so a token sent
// without slashes or a scheme can never reach the log. The cleaned
// URL passes through redactSensitiveText as a last step, so a
// key=value secret embedded in a path segment is redacted too.
export function sanitizeCspReportUrl(value: string): string {
  const trimmed = stripControlChars(value).trim();
  if (trimmed === '') {
    return '[redacted]';
  }
  if (BARE_BLOCKED_KEYWORDS.has(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '[redacted]';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return parsed.protocol;
  }
  const path = redactLongPathSegments(parsed.pathname);
  const cleaned = `${parsed.protocol}//${parsed.host}${path}`;
  return redactSensitiveText(cleaned).slice(0, CSP_REPORT_MAX_URL_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(
  obj: Record<string, unknown>,
  key: string,
  label: string,
  issues: CspReportValidationIssue[],
  maxLength: number,
): string | undefined {
  const raw = obj[key];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    issues.push({ field: label, issue: 'must be a string' });
    return undefined;
  }
  if (raw.length > maxLength) {
    issues.push({ field: label, issue: 'is too long' });
    return undefined;
  }
  return raw;
}

function readIntField(
  obj: Record<string, unknown>,
  key: string,
  label: string,
  issues: CspReportValidationIssue[],
  min: number,
  max: number,
): number | undefined {
  const raw = obj[key];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    issues.push({ field: label, issue: `must be an integer between ${min} and ${max}` });
    return undefined;
  }
  return raw;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value;
}

function assignIfPresent<T>(target: SanitizedCspReport, key: keyof SanitizedCspReport, value: T | undefined): void {
  if (value !== undefined) {
    (target as unknown as Record<string, unknown>)[key] = value;
  }
}

function hasIssue(issues: CspReportValidationIssue[], field: string): boolean {
  return issues.some((issue) => issue.field === field);
}

function buildSanitizedReport(
  format: SanitizedCspReport['format'],
  documentUri: string,
  fields: {
    referrer?: string;
    violatedDirective?: string;
    effectiveDirective?: string;
    originalPolicy?: string;
    disposition?: string;
    blockedUri?: string;
    lineNumber?: number;
    columnNumber?: number;
    sourceFile?: string;
    statusCode?: number;
    sample?: string;
  },
): SanitizedCspReport {
  const report: SanitizedCspReport = { format, documentUri: sanitizeCspReportUrl(documentUri) };
  assignIfPresent(report, 'referrer', nonEmpty(fields.referrer) && sanitizeCspReportUrl(fields.referrer as string));
  assignIfPresent(
    report,
    'violatedDirective',
    nonEmpty(fields.violatedDirective) && redactSensitiveText(fields.violatedDirective as string),
  );
  assignIfPresent(
    report,
    'effectiveDirective',
    nonEmpty(fields.effectiveDirective) && redactSensitiveText(fields.effectiveDirective as string),
  );
  assignIfPresent(
    report,
    'originalPolicy',
    nonEmpty(fields.originalPolicy) && redactSensitiveText(fields.originalPolicy as string),
  );
  assignIfPresent(
    report,
    'disposition',
    nonEmpty(fields.disposition) && redactSensitiveText(fields.disposition as string),
  );
  assignIfPresent(report, 'blockedUri', nonEmpty(fields.blockedUri) && sanitizeCspReportUrl(fields.blockedUri as string));
  assignIfPresent(report, 'lineNumber', fields.lineNumber);
  assignIfPresent(report, 'columnNumber', fields.columnNumber);
  assignIfPresent(report, 'sourceFile', nonEmpty(fields.sourceFile) && sanitizeCspReportUrl(fields.sourceFile as string));
  assignIfPresent(report, 'statusCode', fields.statusCode);
  const sample = nonEmpty(fields.sample);
  if (sample !== undefined) {
    report.sample = redactSensitiveText(sample).slice(0, CSP_REPORT_MAX_SAMPLE_LOG_LENGTH);
  }
  return report;
}

function parseLegacyReport(
  body: Record<string, unknown>,
  issues: CspReportValidationIssue[],
): SanitizedCspReport | undefined {
  const raw = body['csp-report'];
  if (raw === undefined) {
    issues.push({ field: 'csp-report', issue: 'is required' });
    return undefined;
  }
  if (!isRecord(raw)) {
    issues.push({ field: 'csp-report', issue: 'must be an object' });
    return undefined;
  }
  const documentUri = readStringField(raw, 'document-uri', 'csp-report.document-uri', issues, CSP_REPORT_MAX_URL_LENGTH);
  const violated = readStringField(
    raw,
    'violated-directive',
    'csp-report.violated-directive',
    issues,
    CSP_REPORT_MAX_DIRECTIVE_LENGTH,
  );
  const effective = readStringField(
    raw,
    'effective-directive',
    'csp-report.effective-directive',
    issues,
    CSP_REPORT_MAX_DIRECTIVE_LENGTH,
  );
  const referrer = readStringField(raw, 'referrer', 'csp-report.referrer', issues, CSP_REPORT_MAX_URL_LENGTH);
  const policy = readStringField(raw, 'original-policy', 'csp-report.original-policy', issues, CSP_REPORT_MAX_POLICY_LENGTH);
  const disposition = readStringField(raw, 'disposition', 'csp-report.disposition', issues, CSP_REPORT_MAX_DIRECTIVE_LENGTH);
  const blocked = readStringField(raw, 'blocked-uri', 'csp-report.blocked-uri', issues, CSP_REPORT_MAX_URL_LENGTH);
  const lineNumber = readIntField(raw, 'line-number', 'csp-report.line-number', issues, 0, 1000000);
  const columnNumber = readIntField(raw, 'column-number', 'csp-report.column-number', issues, 0, 1000000);
  const sourceFile = readStringField(raw, 'source-file', 'csp-report.source-file', issues, CSP_REPORT_MAX_URL_LENGTH);
  const statusCode = readIntField(raw, 'status-code', 'csp-report.status-code', issues, 0, 999);
  const sample = readStringField(raw, 'script-sample', 'csp-report.script-sample', issues, CSP_REPORT_BODY_LIMIT_BYTES);
  if (nonEmpty(documentUri) === undefined && !hasIssue(issues, 'csp-report.document-uri')) {
    issues.push({ field: 'csp-report.document-uri', issue: 'must not be empty' });
  }
  if (
    nonEmpty(violated) === undefined &&
    nonEmpty(effective) === undefined &&
    !hasIssue(issues, 'csp-report.violated-directive') &&
    !hasIssue(issues, 'csp-report.effective-directive')
  ) {
    issues.push({
      field: 'csp-report.violated-directive',
      issue: 'is required when effective-directive is absent',
    });
  }
  if (issues.length > 0 || documentUri === undefined) {
    return undefined;
  }
  return buildSanitizedReport('csp-report', documentUri, {
    referrer,
    violatedDirective: violated,
    effectiveDirective: effective,
    originalPolicy: policy,
    disposition,
    blockedUri: blocked,
    lineNumber,
    columnNumber,
    sourceFile,
    statusCode,
    sample,
  });
}

function parseReportingApiReport(
  raw: unknown,
  labelPrefix: string,
  issues: CspReportValidationIssue[],
): SanitizedCspReport | undefined {
  const label = (field: string): string => (labelPrefix === '' ? field : `${labelPrefix}.${field}`);
  if (!isRecord(raw)) {
    issues.push({ field: labelPrefix === '' ? 'report' : labelPrefix, issue: 'must be an object' });
    return undefined;
  }
  const type = readStringField(raw, 'type', label('type'), issues, CSP_REPORT_MAX_DIRECTIVE_LENGTH);
  if (type !== undefined && type !== 'csp-violation') {
    issues.push({ field: label('type'), issue: 'must be csp-violation' });
  }
  const url = readStringField(raw, 'url', label('url'), issues, CSP_REPORT_MAX_URL_LENGTH);
  const body = raw['body'];
  if (body === undefined) {
    issues.push({ field: label('body'), issue: 'is required' });
    return undefined;
  }
  if (!isRecord(body)) {
    issues.push({ field: label('body'), issue: 'must be an object' });
    return undefined;
  }
  const documentUri = readStringField(body, 'documentURL', label('body.documentURL'), issues, CSP_REPORT_MAX_URL_LENGTH);
  const violated = readStringField(
    body,
    'violatedDirective',
    label('body.violatedDirective'),
    issues,
    CSP_REPORT_MAX_DIRECTIVE_LENGTH,
  );
  const effective = readStringField(
    body,
    'effectiveDirective',
    label('body.effectiveDirective'),
    issues,
    CSP_REPORT_MAX_DIRECTIVE_LENGTH,
  );
  const referrer = readStringField(body, 'referrer', label('body.referrer'), issues, CSP_REPORT_MAX_URL_LENGTH);
  const policy = readStringField(body, 'originalPolicy', label('body.originalPolicy'), issues, CSP_REPORT_MAX_POLICY_LENGTH);
  const disposition = readStringField(body, 'disposition', label('body.disposition'), issues, CSP_REPORT_MAX_DIRECTIVE_LENGTH);
  const blocked = readStringField(body, 'blockedURL', label('body.blockedURL'), issues, CSP_REPORT_MAX_URL_LENGTH);
  const lineNumber = readIntField(body, 'lineNumber', label('body.lineNumber'), issues, 0, 1000000);
  const columnNumber = readIntField(body, 'columnNumber', label('body.columnNumber'), issues, 0, 1000000);
  const sourceFile = readStringField(body, 'sourceFile', label('body.sourceFile'), issues, CSP_REPORT_MAX_URL_LENGTH);
  const statusCode = readIntField(body, 'statusCode', label('body.statusCode'), issues, 0, 999);
  const sample = readStringField(body, 'sample', label('body.sample'), issues, CSP_REPORT_BODY_LIMIT_BYTES);
  const effectiveDocument = nonEmpty(documentUri) ?? nonEmpty(url);
  if (effectiveDocument === undefined && !hasIssue(issues, label('body.documentURL')) && !hasIssue(issues, label('url'))) {
    issues.push({ field: label('body.documentURL'), issue: 'must not be empty' });
  }
  if (
    nonEmpty(violated) === undefined &&
    nonEmpty(effective) === undefined &&
    !hasIssue(issues, label('body.violatedDirective')) &&
    !hasIssue(issues, label('body.effectiveDirective'))
  ) {
    issues.push({
      field: label('body.violatedDirective'),
      issue: 'is required when effectiveDirective is absent',
    });
  }
  if (issues.length > 0 || effectiveDocument === undefined) {
    return undefined;
  }
  return buildSanitizedReport('reporting-api', effectiveDocument, {
    referrer,
    violatedDirective: violated,
    effectiveDirective: effective,
    originalPolicy: policy,
    disposition,
    blockedUri: blocked,
    lineNumber,
    columnNumber,
    sourceFile,
    statusCode,
    sample,
  });
}

// Validate a parsed JSON body and return sanitized reports, or the
// list of shape problems. Unknown fields are dropped silently (see
// the header comment). This function is pure and never logs.
export function parseCspReportBody(body: unknown): CspReportParseResult {
  const issues: CspReportValidationIssue[] = [];
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { ok: false, issues: [{ field: 'reports', issue: 'must not be empty' }] };
    }
    if (body.length > CSP_REPORT_MAX_REPORTS_PER_REQUEST) {
      return {
        ok: false,
        issues: [{ field: 'reports', issue: `exceeds the maximum of ${CSP_REPORT_MAX_REPORTS_PER_REQUEST} reports` }],
      };
    }
    const reports: SanitizedCspReport[] = [];
    body.forEach((entry, index) => {
      const before = issues.length;
      const parsed = parseReportingApiReport(entry, `[${index}]`, issues);
      if (parsed !== undefined && issues.length === before) {
        reports.push(parsed);
      }
    });
    if (issues.length > 0) {
      return { ok: false, issues };
    }
    return { ok: true, reports };
  }
  if (isRecord(body)) {
    if ('csp-report' in body) {
      const parsed = parseLegacyReport(body, issues);
      if (issues.length > 0 || parsed === undefined) {
        return { ok: false, issues };
      }
      return { ok: true, reports: [parsed] };
    }
    if ('body' in body) {
      const parsed = parseReportingApiReport(body, '', issues);
      if (issues.length > 0 || parsed === undefined) {
        return { ok: false, issues };
      }
      return { ok: true, reports: [parsed] };
    }
    return {
      ok: false,
      issues: [{ field: 'body', issue: 'must be a CSP report object or an array of reports' }],
    };
  }
  return {
    ok: false,
    issues: [{ field: 'body', issue: 'must be a CSP report object or an array of reports' }],
  };
}

export interface CspReportRateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface CspReportRateLimiter {
  check: (ip: string, nowMs?: number) => CspReportRateLimitVerdict;
  trackedIps: () => number;
}

export interface CspReportRateLimiterOptions {
  maxReports?: number;
  windowMs?: number;
  maxTrackedIps?: number;
}

// Fixed-window limiter, one window per client IP. Expired windows
// are pruned on every check; when the IP table is full, the oldest
// entry is evicted. The clock is injectable through check() for
// tests; production callers omit nowMs and get Date.now().
export function createCspReportRateLimiter(options: CspReportRateLimiterOptions = {}): CspReportRateLimiter {
  const maxReports = options.maxReports ?? CSP_REPORT_RATE_LIMIT_MAX;
  const windowMs = options.windowMs ?? CSP_REPORT_RATE_LIMIT_WINDOW_MS;
  const maxTrackedIps = options.maxTrackedIps ?? CSP_REPORT_RATE_LIMIT_MAX_IPS;
  const windows = new Map<string, { windowStart: number; count: number }>();

  function prune(now: number): void {
    for (const [ip, entry] of windows) {
      if (entry.windowStart + windowMs <= now) {
        windows.delete(ip);
      }
    }
  }

  return {
    check(ip: string, nowMs?: number): CspReportRateLimitVerdict {
      const now = nowMs ?? Date.now();
      const key = ip === '' ? 'unknown' : ip;
      prune(now);
      const existing = windows.get(key);
      if (existing === undefined) {
        if (windows.size >= maxTrackedIps) {
          const oldest = windows.keys().next();
          if (!oldest.done) {
            windows.delete(oldest.value);
          }
        }
        windows.set(key, { windowStart: now, count: 1 });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (existing.count < maxReports) {
        existing.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.windowStart + windowMs - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    },
    trackedIps(): number {
      return windows.size;
    },
  };
}

export interface CspReportRouteDeps {
  rateLimiter?: CspReportRateLimiter;
  // Test and observability hook: called with each sanitized report
  // in addition to the structured log. Production wiring passes no
  // sink; the log is the only record.
  reportSink?: (report: SanitizedCspReport) => void;
}

function contentTypeError(code: string, message: string): Error & { code: string; statusCode: number } {
  const error = new Error(message) as Error & { code: string; statusCode: number };
  error.code = code;
  error.statusCode = 400;
  return error;
}

// Browsers send reports as application/csp-report (legacy) or
// application/reports+json (Reporting API), neither of which the
// default Fastify JSON parser handles. These parsers decode exactly
// those two types as JSON and map failures onto the same error codes
// the global handler already turns into invalid_json.
function registerCspReportContentTypeParsers(app: FastifyInstance): void {
  for (const contentType of REPORTING_API_TYPES) {
    if (app.hasContentTypeParser(contentType)) {
      continue;
    }
    app.addContentTypeParser(
      contentType,
      { parseAs: 'string' },
      (_request: FastifyRequest, body: string, done: (err: Error | null, result?: unknown) => void) => {
        if (body === '') {
          done(contentTypeError('FST_ERR_CTP_EMPTY_JSON_BODY', 'Body cannot be empty when content-type is set to JSON.'));
          return;
        }
        try {
          done(null, JSON.parse(body) as unknown);
        } catch {
          done(contentTypeError('FST_ERR_CTP_INVALID_JSON_BODY', 'Body is not valid JSON.'));
        }
      },
    );
  }
}

export async function registerCspReportRoutes(app: FastifyInstance, deps: CspReportRouteDeps = {}): Promise<void> {
  registerCspReportContentTypeParsers(app);
  const rateLimiter = deps.rateLimiter ?? createCspReportRateLimiter();

  app.post(
    CSP_REPORT_PATH,
    { bodyLimit: CSP_REPORT_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const verdict = rateLimiter.check(request.ip ?? 'unknown');
      if (!verdict.allowed) {
        // Rejected reports are not logged: logging them would let a
        // flooding reporter fill the log through the rejection path.
        // The 429 envelope is sent directly so the Retry-After header
        // is guaranteed to travel with it.
        reply.header('Retry-After', String(verdict.retryAfterSeconds));
        reply.code(429).send(errorEnvelope('rate_limited', 'Too many requests.', request.id, { retryable: true }));
        return;
      }
      const parsed = parseCspReportBody(request.body);
      if (!parsed.ok) {
        throw ApiError.validation('Request validation failed.', { fields: parsed.issues });
      }
      for (const report of parsed.reports) {
        request.log.warn({ event: 'csp_report', report }, 'Content Security Policy violation reported');
        deps.reportSink?.(report);
      }
      reply.code(204).send();
    },
  );
}
