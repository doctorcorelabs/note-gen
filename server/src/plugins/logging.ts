// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Logger configuration for the Fastify app.
//
// Two rules from the Fase 0 health design and desain-auth.md section 1.9
// are enforced here:
// - Request logging stays disabled (app.ts uses LogController with
//   disableRequestLogging). Health probes arrive every few seconds and
//   must not flood the log; only failures are logged, with codes.
// - Credential-carrying headers are redacted at the logger level, so a
//   future request log or error log can never print a session cookie,
//   an authorization header, a CSRF token, a Cloudflare Access JWT, or
//   a Set-Cookie value. Redaction is defense in depth: handlers must
//   still never log these values explicitly.

export const LOGGER_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["cf-access-jwt-assertion"]',
  'res.headers["set-cookie"]',
] as const;

export function buildLoggerOptions(logLevel: string): { level: string; redact: { paths: string[]; censor: string } } {
  return {
    level: logLevel,
    redact: { paths: [...LOGGER_REDACT_PATHS], censor: '[REDACTED]' },
  };
}
