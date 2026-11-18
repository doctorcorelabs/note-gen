// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Auth context: the assembled dependencies of the auth core. The
// context is built once per application in buildApp (see app.ts) and
// passed explicitly to route registration, verifiers, and the auth
// service. Secrets are read from the process environment by value
// here, and only here: config/env.ts deliberately keeps only
// presence/length flags, and this module is the one place that
// holds secret values in memory. No secret value is ever logged.
//
// When the database is not configured, the store is null and every
// auth path fails closed (verifiers return null/false, handlers
// answer 503). The application still boots so health endpoints keep
// reporting ready state honestly. When a database URL is configured
// but unusable, the store is likewise null: startup must not crash
// on a database the health checks are meant to report on.
//
// Tests construct contexts directly with a fake store and a fast
// test-only hasher; production always uses Argon2PasswordHasher.

import { randomBytes } from 'node:crypto';
import { createDb, type DbHandle } from '../db/index.js';
import type { ServerConfig } from '../config/env.js';
import { ApiError } from '../plugins/envelope.js';
import { Argon2PasswordHasher, type PasswordHasher } from './passwords.js';
import { DrizzleAuthStore, type AuthStore } from './store.js';

export interface AuthContext {
  store: AuthStore | null;
  hasher: PasswordHasher;
  authSecret: string | undefined;
  setupToken: string | undefined;
  encryptionKey: string | undefined;
  canonicalOrigin: string | undefined;
  trustProxy: boolean;
  cookieSecure: boolean;
  registrationMode: ServerConfig['registrationMode'];
  clock: () => number;
  dummyPasswordHash: () => Promise<string>;
  close: () => Promise<void>;
}


export interface AuthContextOverrides {
  store?: AuthStore | null;
  hasher?: PasswordHasher;
  authSecret?: string | undefined;
  setupToken?: string | undefined;
  encryptionKey?: string | undefined;
  canonicalOrigin?: string | undefined;
  trustProxy?: boolean;
  cookieSecure?: boolean;
  registrationMode?: ServerConfig['registrationMode'];
  clock?: () => number;
}

export function createAuthContext(overrides: AuthContextOverrides = {}): AuthContext {
  const hasher = overrides.hasher ?? new Argon2PasswordHasher();
  let dummyHashPromise: Promise<string> | null = null;
  // The dummy password is generated fresh per context at runtime, so
  // no password literal exists in the source. It is hashed once and
  // cached; its only purpose is to give unknown-email logins the same
  // Argon2 cost as a real verification (anti-enumeration timing).
  let dummyPassword: string | null = null;
  return {
    store: overrides.store ?? null,
    hasher,
    authSecret: overrides.authSecret,
    setupToken: overrides.setupToken,
    encryptionKey: overrides.encryptionKey,
    canonicalOrigin: overrides.canonicalOrigin,
    trustProxy: overrides.trustProxy ?? false,
    cookieSecure: overrides.cookieSecure ?? false,
    registrationMode: overrides.registrationMode ?? 'closed',
    clock: overrides.clock ?? (() => Date.now()),
    dummyPasswordHash: () => {
      dummyPassword ??= randomBytes(32).toString('base64url');
      dummyHashPromise ??= hasher.hash(dummyPassword);
      return dummyHashPromise;
    },
    close: async () => {},
  };
}

export interface SetupPrerequisiteFlags {
  setupTokenConfigured: boolean;
  setupTokenLengthOk: boolean;
}

// Builds the production context from the validated server config.
// Secret values come from the process environment: AUTH_SECRET,
// SETUP_TOKEN, ENCRYPTION_KEY (canonical; SECRETS_ENCRYPTION_KEY is
// accepted as an alias, matching loadConfig behavior; whether the
// alias is removed is an open integrator decision, recorded in the
// V3-01b report). The database handle is isolated per application
// (createDb, not the process singleton) so buildApp stays safe to
// call repeatedly in tests; close() ends the handle.
export function createAuthContextFromConfig(
  config: ServerConfig,
  overrides: AuthContextOverrides = {},
): AuthContext {
  let handle: DbHandle | null = null;
  let store: AuthStore | null = null;
  if (overrides.store !== undefined) {
    store = overrides.store;
  } else if (config.databaseUrl !== undefined && config.databaseUrl.trim() !== '') {
    try {
      handle = createDb(config.databaseUrl);
      store = new DrizzleAuthStore(handle.db);
    } catch {
      handle = null;
      store = null;
    }
  }
  const encryptionKey =
    overrides.encryptionKey ??
    process.env.ENCRYPTION_KEY ??
    process.env.SECRETS_ENCRYPTION_KEY ??
    undefined;
  const base = createAuthContext({
    store,
    authSecret: overrides.authSecret ?? process.env.AUTH_SECRET ?? undefined,
    setupToken: overrides.setupToken ?? process.env.SETUP_TOKEN ?? undefined,
    encryptionKey,
    canonicalOrigin: overrides.canonicalOrigin ?? config.publicBaseUrl,
    trustProxy: overrides.trustProxy ?? config.trustProxy,
    cookieSecure: overrides.cookieSecure ?? config.cookieSecure,
    registrationMode: overrides.registrationMode ?? config.registrationMode,
    clock: overrides.clock,
    hasher: overrides.hasher,
  });
  let closed = false;
  return {
    ...base,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      if (handle !== null) {
        await handle.close();
      }
    },
  };
}

// Returns the store or throws a 503. Auth handlers call this at the
// top of every database-backed path; verifiers instead treat a null
// store as "no valid session" and return null/false.
export function requireStore(context: AuthContext): AuthStore {
  if (context.store === null) {
    throw ApiError.serviceUnavailable('The database is not available.');
  }
  return context.store;
}

// SETUP_TOKEN boot prerequisite (V2-02 handoff, desain-auth.md
// section 2.1): when the database holds no accounts, boot must
// refuse unless a setup token of sufficient length is configured.
// Returns 'ok' or 'refused'; database errors propagate so the caller
// (server.ts) can warn and continue when migrations have not run
// yet, instead of refusing boot for an unmigrated database.
export async function checkSetupBootPrerequisite(
  store: AuthStore,
  flags: SetupPrerequisiteFlags,
): Promise<'ok' | 'refused'> {
  const userCount = await store.getUserCount();
  if (userCount > 0) {
    return 'ok';
  }
  if (!flags.setupTokenConfigured || !flags.setupTokenLengthOk) {
    return 'refused';
  }
  return 'ok';
}

// Single-account boot prerequisite (DA-22-01/02/03, S-P0-13/S-P0-14/
// S-P0-15): the file layer shares one filesystem root across
// accounts, so a deployment that has chosen single-account must
// refuse to serve when the database holds more than one account.
// Returns 'ok' or 'refused'; database errors propagate so the caller
// (server.ts) can warn and continue when migrations have not run
// yet, the same rule as the setup prerequisite above. A count of
// zero is 'ok': the first account is still to be created through
// setup.
export async function checkSingleAccountPrerequisite(store: AuthStore): Promise<'ok' | 'refused'> {
  const userCount = await store.getUserCount();
  if (userCount > 1) {
    return 'refused';
  }
  return 'ok';
}
