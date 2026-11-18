// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Parsing and validation of server environment variables.
//
// Fase 0 rules (desain-health-endpoint.md section 6.3), unchanged:
// - DATABASE_URL and WORKSPACE_ROOT have no silent defaults. When missing,
//   the server still starts, liveness still answers, and readiness fails
//   with a machine error code. A missing config must never be hidden.
// - WORKSPACE_ROOT is the only accepted workspace variable name. No fallback
//   to WORKSPACE_PATH, STORAGE_ROOT, or DATA_ROOT.
// - Only PORT misconfiguration fails startup in Fase 0, because a wrong
//   port makes the server unreachable at all. Every other invalid value
//   falls back to a default plus a startup warning that names the variable
//   only, never its value. Values, in particular DATABASE_URL, are never
//   logged.
//
// Fase 1 additions (desain-auth.md sections 2.1, 4.2, 5.3, 7.6, 13):
// - Auth and security variables are validated here, but secret VALUES are
//   never stored in ServerConfig and never logged. Only presence and
//   length-ok flags are recorded. The auth worker owns secret handling
//   and reads secrets through its own module; this module only proves the
//   deployment named them and that obvious misconfigurations fail closed.
// - Fail-closed boot refusals (loadConfig throws, server.ts exits):
//   an invalid PORT; a REGISTRATION_MODE value other than closed
//   (AD-201 single-account enforcement; section 2.1);
//   an unrecognized CF_ACCESS_ENABLED value (section 7.2); a
//   Cloudflare Access deployment without its audience or team domain;
//   a production deployment with Access verification disabled, and a
//   development deployment with Access disabled but a non-localhost
//   canonical origin (section 7.6); and an insecure cookie flag outside
//   development on localhost (section 4.2). Each refusal message names
//   the variable only, never its value.
// - SETUP_TOKEN is presence-and-length only here on purpose. Whether a
//   missing or short setup token must refuse boot depends on database
//   state (section 2.2: only when no account exists yet), which this
//   module cannot see. The auth worker enforces that boot prerequisite
//   after the database is reachable; this module only records the flags
//   it needs.

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string | undefined;
  workspaceRoot: string | undefined;
  // Optional deployment roots (W4-WIRE). assetRoot is the
  // dedicated asset store root OUTSIDE the workspace tree
  // (desain V1-14: assets must never live under the workspace
  // root); trashRoot overrides the sibling trash default
  // (desain-workspace-api.md section 5.1). Both are optional so
  // existing config literals keep compiling: when unset, the
  // owning routes fail closed per request (assets) or fall back
  // to the derived default (trash). No silent derivation from
  // the workspace root is ever applied to assets.
  assetRoot?: string | undefined;
  trashRoot?: string | undefined;
  nodeEnv: 'development' | 'production';
  logLevel: string;
  checkTimeoutMs: number;
  overallTimeoutMs: number;
  warnings: string[];
  // AD-201 single-account: only 'closed' is expressible in a typed
  // config. loadConfig refuses boot for any other REGISTRATION_MODE
  // value, so no code path can observe a non-closed mode.
  registrationMode: 'closed';
  publicBaseUrl: string | undefined;
  trustProxy: boolean;
  cookieSecure: boolean;
  cfAccessEnabled: boolean;
  cfAccessTeamDomain: string | undefined;
  cfAccessAud: string | undefined;
  cfAccessServiceAud: string | undefined;
  cfAccessJwksCacheTtlSeconds: number;
  jwtAudience: string | undefined;
  authSecretConfigured: boolean;
  authSecretLengthOk: boolean;
  encryptionKeyConfigured: boolean;
  setupTokenConfigured: boolean;
  setupTokenLengthOk: boolean;
  maxBodyBytes: number;
}

export const DEFAULT_PORT = 3001;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_CHECK_TIMEOUT_MS = 2000;
export const DEFAULT_OVERALL_TIMEOUT_MS = 5000;
export const DEFAULT_BODY_LIMIT_BYTES = 1048576;
export const MAX_BODY_LIMIT_BYTES = 104857600;
export const DEFAULT_JWKS_CACHE_TTL_SECONDS = 3600;
export const MIN_SECRET_LENGTH = 32;

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

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'true') {
    return true;
  }
  if (lowered === 'false') {
    return false;
  }
  return undefined;
}

function nonEmpty(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return raw.trim();
}

// Normalize a configured base URL to its origin (scheme + host + port),
// which is the only form used for Origin comparison. Returns undefined
// when the value cannot be parsed as an absolute URL.
function normalizeOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

function isLocalhostOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return false;
  }
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
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

  // Optional roots: no warning when unset. Assets fail closed per
  // request without ASSET_ROOT, and trash falls back to its
  // derived sibling default without TRASH_ROOT; neither blocks
  // readiness, so neither belongs in the boot warnings.
  const assetRoot = nonEmpty(env.ASSET_ROOT);
  const trashRoot = nonEmpty(env.TRASH_ROOT);

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

  // Single-account enforcement (AD-201; DA22-07): the only accepted
  // registration mode is 'closed'. The 'invitation' and 'open'
  // values name flows that do not exist (no invitation endpoint,
  // register always answers 404), so accepting them would silently
  // mislead the operator. Refusing boot keeps the single-account
  // invariant formal instead of accidental. Each refusal message
  // names the variable only, never its value.
  let registrationMode: 'closed' = 'closed';
  if (env.REGISTRATION_MODE !== undefined && nonEmpty(env.REGISTRATION_MODE) !== undefined) {
    const raw = nonEmpty(env.REGISTRATION_MODE);
    if (raw === 'closed') {
      registrationMode = raw;
    } else if (raw === 'invitation' || raw === 'open') {
      throw new Error('REGISTRATION_MODE must be closed: this deployment is single-account (AD-201) and invitation/open registration is not supported.');
    } else {
      throw new Error('REGISTRATION_MODE is not recognized: it must be closed.');
    }
  }

  let publicBaseUrl: string | undefined;
  if (env.PUBLIC_BASE_URL !== undefined && nonEmpty(env.PUBLIC_BASE_URL) !== undefined) {
    const raw = nonEmpty(env.PUBLIC_BASE_URL);
    const origin = normalizeOrigin(raw);
    if (origin === undefined || origin === 'null') {
      warnings.push('PUBLIC_BASE_URL is not a valid absolute URL; Origin checks will fail closed.');
    } else {
      publicBaseUrl = origin;
      if (raw !== undefined && raw !== origin && !raw.startsWith(`${origin}/`)) {
        warnings.push('PUBLIC_BASE_URL has a non-origin part; only its origin is used.');
      }
      if (nodeEnv === 'production' && !origin.startsWith('https://')) {
        warnings.push('PUBLIC_BASE_URL is not HTTPS in production.');
      }
    }
  } else if (env.PUBLIC_BASE_URL !== undefined) {
    warnings.push('PUBLIC_BASE_URL is empty; Origin checks will fail closed.');
  }

  let trustProxy = false;
  if (env.TRUST_PROXY !== undefined && nonEmpty(env.TRUST_PROXY) !== undefined) {
    const parsed = parseBoolean(env.TRUST_PROXY);
    if (parsed === undefined) {
      warnings.push('TRUST_PROXY is not recognized, using false.');
    } else {
      trustProxy = parsed;
    }
  }

  let cookieSecure = true;
  if (env.COOKIE_SECURE !== undefined && nonEmpty(env.COOKIE_SECURE) !== undefined) {
    const parsed = parseBoolean(env.COOKIE_SECURE);
    if (parsed === undefined) {
      warnings.push('COOKIE_SECURE is not recognized, using true.');
    } else {
      cookieSecure = parsed;
    }
  }
  if (cookieSecure === false) {
    const devLocalhost = nodeEnv === 'development' && (publicBaseUrl === undefined || isLocalhostOrigin(publicBaseUrl));
    if (!devLocalhost) {
      throw new Error(
        'COOKIE_SECURE=false is only allowed when NODE_ENV is development and PUBLIC_BASE_URL is localhost.',
      );
    }
  }

  let cfAccessEnabled = false;
  if (env.CF_ACCESS_ENABLED !== undefined && nonEmpty(env.CF_ACCESS_ENABLED) !== undefined) {
    const parsed = parseBoolean(env.CF_ACCESS_ENABLED);
    if (parsed === undefined) {
      throw new Error('CF_ACCESS_ENABLED is not recognized: it must be true or false.');
    } else {
      cfAccessEnabled = parsed;
    }
  }
  const cfAccessTeamDomain = nonEmpty(env.CF_ACCESS_TEAM_DOMAIN);
  const cfAccessAud = nonEmpty(env.CF_ACCESS_AUD);
  const cfAccessServiceAud = nonEmpty(env.CF_ACCESS_SERVICE_AUD);
  if (cfAccessEnabled) {
    if (cfAccessAud === undefined) {
      throw new Error('CF_ACCESS_AUD must be set when CF_ACCESS_ENABLED is true.');
    }
    if (cfAccessTeamDomain === undefined) {
      throw new Error('CF_ACCESS_TEAM_DOMAIN must be set when CF_ACCESS_ENABLED is true.');
    }
  } else if (nodeEnv === 'production') {
    throw new Error('CF_ACCESS_ENABLED must be true when NODE_ENV is production.');
  } else if (publicBaseUrl !== undefined && !isLocalhostOrigin(publicBaseUrl)) {
    // Disabled Access is only allowed for local development: a
    // non-localhost canonical origin means the deployment is reachable
    // beyond localhost, where the Access perimeter must be on. An
    // unset PUBLIC_BASE_URL keeps the local-dev assumption.
    throw new Error(
      'CF_ACCESS_ENABLED must be true when PUBLIC_BASE_URL is not localhost.',
    );
  }

  let cfAccessJwksCacheTtlSeconds = DEFAULT_JWKS_CACHE_TTL_SECONDS;
  if (env.CF_ACCESS_JWKS_CACHE_TTL_SECONDS !== undefined && nonEmpty(env.CF_ACCESS_JWKS_CACHE_TTL_SECONDS) !== undefined) {
    const parsed = parsePositiveInt(env.CF_ACCESS_JWKS_CACHE_TTL_SECONDS);
    if (parsed === undefined) {
      warnings.push('CF_ACCESS_JWKS_CACHE_TTL_SECONDS is not valid, using the default.');
    } else {
      cfAccessJwksCacheTtlSeconds = parsed;
    }
  }

  const jwtAudience = nonEmpty(env.JWT_AUDIENCE);

  const authSecretRaw = env.AUTH_SECRET;
  const authSecretConfigured = nonEmpty(authSecretRaw) !== undefined;
  const authSecretLengthOk = authSecretConfigured && (authSecretRaw as string).trim().length >= MIN_SECRET_LENGTH;
  if (!authSecretConfigured) {
    warnings.push('AUTH_SECRET is not set; authentication will fail closed until it is set.');
  } else if (!authSecretLengthOk) {
    warnings.push('AUTH_SECRET is shorter than the required minimum length.');
  }

  // Canonical name is ENCRYPTION_KEY (desain-auth.md section 1.4).
  // server/.env.example also names SECRETS_ENCRYPTION_KEY from the Fase 0
  // hygiene draft. Either name counts as configured; the secret owner
  // decides the single canonical name before the first deploy. Only the
  // presence flag is recorded, never the value.
  const encryptionKeyConfigured =
    nonEmpty(env.ENCRYPTION_KEY) !== undefined || nonEmpty(env.SECRETS_ENCRYPTION_KEY) !== undefined;
  if (!encryptionKeyConfigured) {
    warnings.push('ENCRYPTION_KEY is not set; sealed secrets cannot be handled until it is set.');
  } else if (nonEmpty(env.ENCRYPTION_KEY) === undefined) {
    warnings.push('Only SECRETS_ENCRYPTION_KEY is set; the canonical name is ENCRYPTION_KEY.');
  }

  const setupTokenRaw = env.SETUP_TOKEN;
  const setupTokenConfigured = nonEmpty(setupTokenRaw) !== undefined;
  const setupTokenLengthOk = setupTokenConfigured && (setupTokenRaw as string).trim().length >= MIN_SECRET_LENGTH;
  if (!setupTokenConfigured) {
    warnings.push('SETUP_TOKEN is not set; first-account setup cannot run until it is set.');
  } else if (!setupTokenLengthOk) {
    warnings.push('SETUP_TOKEN is shorter than the required minimum length.');
  }

  let maxBodyBytes = DEFAULT_BODY_LIMIT_BYTES;
  if (env.BODY_LIMIT_BYTES !== undefined && nonEmpty(env.BODY_LIMIT_BYTES) !== undefined) {
    const parsed = parsePositiveInt(env.BODY_LIMIT_BYTES);
    if (parsed === undefined || parsed > MAX_BODY_LIMIT_BYTES) {
      warnings.push('BODY_LIMIT_BYTES is not valid, using the default.');
    } else {
      maxBodyBytes = parsed;
    }
  }

  return {
    host,
    port,
    databaseUrl,
    workspaceRoot,
    assetRoot,
    trashRoot,
    nodeEnv,
    logLevel,
    checkTimeoutMs,
    overallTimeoutMs,
    warnings,
    registrationMode,
    publicBaseUrl,
    trustProxy,
    cookieSecure,
    cfAccessEnabled,
    cfAccessTeamDomain,
    cfAccessAud,
    cfAccessServiceAud,
    cfAccessJwksCacheTtlSeconds,
    jwtAudience,
    authSecretConfigured,
    authSecretLengthOk,
    encryptionKeyConfigured,
    setupTokenConfigured,
    setupTokenLengthOk,
    maxBodyBytes,
  };
}
