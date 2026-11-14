// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Parsing and validation of server environment variables.
//
// Rules from the Fase 0 health design (desain-health-endpoint.md section 6.3):
// - DATABASE_URL and WORKSPACE_ROOT have no silent defaults. When missing,
//   the server still starts, liveness still answers, and readiness fails
//   with a machine error code. A missing config must never be hidden.
// - WORKSPACE_ROOT is the only accepted workspace variable name. No fallback
//   to WORKSPACE_PATH or STORAGE_ROOT.
// - Only PORT misconfiguration fails startup, because a wrong port makes the
//   server unreachable at all. Every other invalid value falls back to a
//   default plus a startup warning that names the variable only, never its
//   value. Values, in particular DATABASE_URL, are never logged.

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string | undefined;
  workspaceRoot: string | undefined;
  nodeEnv: 'development' | 'production';
  logLevel: string;
  checkTimeoutMs: number;
  overallTimeoutMs: number;
  warnings: string[];
}

export const DEFAULT_PORT = 3001;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_CHECK_TIMEOUT_MS = 2000;
export const DEFAULT_OVERALL_TIMEOUT_MS = 5000;

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error('PORT is not valid: it must be an integer from 1 to 65535.');
  }
  return n;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return undefined;
  }
  return n;
}

function nonEmpty(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return raw.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const warnings: string[] = [];
  const port = parsePort(env.PORT);

  let host = DEFAULT_HOST;
  if (env.HOST !== undefined) {
    const parsed = nonEmpty(env.HOST);
    if (parsed === undefined) {
      warnings.push('HOST is empty, using the default.');
    } else {
      host = parsed;
    }
  }

  const databaseUrl = nonEmpty(env.DATABASE_URL);
  if (databaseUrl === undefined) {
    warnings.push('DATABASE_URL is not set; readiness will fail until it is set.');
  }

  const workspaceRoot = nonEmpty(env.WORKSPACE_ROOT);
  if (workspaceRoot === undefined) {
    warnings.push('WORKSPACE_ROOT is not set; readiness will fail until it is set.');
  }

  let nodeEnv: 'development' | 'production' = 'development';
  if (env.NODE_ENV === 'production') {
    nodeEnv = 'production';
  } else if (env.NODE_ENV !== undefined && env.NODE_ENV !== 'development') {
    warnings.push('NODE_ENV is not recognized, using development.');
  }

  let logLevel = 'info';
  if (env.LOG_LEVEL !== undefined) {
    if (LOG_LEVELS.has(env.LOG_LEVEL)) {
      logLevel = env.LOG_LEVEL;
    } else {
      warnings.push('LOG_LEVEL is not recognized, using info.');
    }
  }

  let checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS;
  if (env.HEALTH_CHECK_TIMEOUT_MS !== undefined && nonEmpty(env.HEALTH_CHECK_TIMEOUT_MS) !== undefined) {
    const parsed = parsePositiveInt(env.HEALTH_CHECK_TIMEOUT_MS);
    if (parsed === undefined) {
      warnings.push('HEALTH_CHECK_TIMEOUT_MS is not valid, using the default.');
    } else {
      checkTimeoutMs = parsed;
    }
  }

  let overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS;
  if (env.HEALTH_OVERALL_TIMEOUT_MS !== undefined && nonEmpty(env.HEALTH_OVERALL_TIMEOUT_MS) !== undefined) {
    const parsed = parsePositiveInt(env.HEALTH_OVERALL_TIMEOUT_MS);
    if (parsed === undefined) {
      warnings.push('HEALTH_OVERALL_TIMEOUT_MS is not valid, using the default.');
    } else {
      overallTimeoutMs = parsed;
    }
  }

  if (overallTimeoutMs <= checkTimeoutMs) {
    warnings.push('HEALTH_OVERALL_TIMEOUT_MS must be larger than HEALTH_CHECK_TIMEOUT_MS, using the default.');
    overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS;
  }

  return {
    host,
    port,
    databaseUrl,
    workspaceRoot,
    nodeEnv,
    logLevel,
    checkTimeoutMs,
    overallTimeoutMs,
    warnings,
  };
}
