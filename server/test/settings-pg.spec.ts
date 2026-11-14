// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Postgres integration tests (V3-10a): the Drizzle store over the
// real M1 tables, through the HTTP routes. Runs only when
// SETTINGS_PG_TEST_URL names a dedicated database (the worker's own
// database, e.g. v3_10a_settings on the shared Fase 1 cluster);
// skipped otherwise so the default suite stays database-free. The
// database is migrated with runMigrations (frozen 0000 migration,
// no new migration) and the test user's rows are deleted before the
// suite runs, so reruns start clean. The fake cipher stands in for
// the V3-10b envelope at the seam; the assertions that matter here
// are the stored bytes (never the plaintext marker), the recorded
// keyVersion, the audit rows, and the idempotency rows.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  auditEvents,
  createDb,
  idempotencyKeys,
  secrets,
  settingRevisions,
  settings,
  users,
  type DbHandle,
} from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { createDrizzleSettingsStore } from '../src/services/settings/drizzle-store.js';
import { FakeSecretCipher } from './support/fake-cipher.js';
import {
  createSettingsTestApp,
  MUTATION_HEADERS,
  SESSION_HEADERS,
  TEST_ORIGIN,
  TEST_PRINCIPAL,
  TEST_USER_ID,
  testVerifyCsrf,
} from './support/settings-test-app.js';

const PG_URL = process.env.SETTINGS_PG_TEST_URL;
const MARKER = 'MARKER-PG-SECRET-VALUE-7F3A9C';
const SECOND_USER_ID = '22222222-2222-4222-8222-222222222222';

const describePg = PG_URL === undefined ? describe.skip : describe;

function bodyOf(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describePg('settings and secrets over Postgres (Drizzle store)', () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let cipher: FakeSecretCipher;

  async function currentRevision(): Promise<number> {
    const response = await app.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/revision' });
    return (bodyOf(response).data as { revision: number }).revision;
  }

  async function patchViaApp(patch: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
    const revision = await currentRevision();
    return app.inject({
      headers: { ...MUTATION_HEADERS, ...extraHeaders },
      method: 'PATCH',
      payload: { baseRevision: revision, settings: patch },
      url: '/api/settings',
    });
  }

  beforeAll(async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = join(here, '..', 'drizzle');
    const result = await runMigrations({ databaseUrl: PG_URL as string, migrationsFolder });
    expect(result.drift.current).toBe(true);
    handle = createDb(PG_URL as string, { max: 5 });
    for (const userId of [TEST_USER_ID, SECOND_USER_ID]) {
      await handle.db.delete(auditEvents).where(eq(auditEvents.actorId, userId));
      await handle.db.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
      await handle.db.delete(secrets).where(eq(secrets.userId, userId));
      await handle.db.delete(settings).where(eq(settings.userId, userId));
      await handle.db.delete(settingRevisions).where(eq(settingRevisions.userId, userId));
      await handle.db.delete(users).where(eq(users.id, userId));
    }
    await handle.db.insert(users).values([
      { id: TEST_USER_ID, login: 'v3-10a-settings-test', passwordHash: 'test-hash-fixture' },
      { id: SECOND_USER_ID, login: 'v3-10a-settings-test-2', passwordHash: 'test-hash-fixture' },
    ]);
    cipher = new FakeSecretCipher();
    const store = createDrizzleSettingsStore(() => handle.db);
    app = await createSettingsTestApp({ cipher, store });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('runs settings CRUD with the revision guard over Postgres', async () => {
    const first = await patchViaApp({ editorViewMode: 'source', language: 'English' });
    expect(first.statusCode).toBe(200);
    expect((bodyOf(first).data as Record<string, unknown>).revision).toBe(1);

    const read = await app.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    expect((bodyOf(read).data as Record<string, unknown>).settings).toEqual({
      editorViewMode: 'source',
      language: 'English',
    });

    const stale = await app.inject({
      headers: MUTATION_HEADERS,
      method: 'PATCH',
      payload: { baseRevision: 0, settings: { language: 'Bahasa' } },
      url: '/api/settings',
    });
    expect(stale.statusCode).toBe(409);
    expect((bodyOf(stale).error as Record<string, unknown>).code).toBe('revision_conflict');

    const rows = await handle.db.select().from(settings).where(eq(settings.userId, TEST_USER_ID));
    expect(rows.map((row) => row.key).sort()).toEqual(['editorViewMode', 'language']);
    const revisionRows = await handle.db
      .select()
      .from(settingRevisions)
      .where(eq(settingRevisions.userId, TEST_USER_ID));
    expect(revisionRows).toHaveLength(1);
    expect(revisionRows[0].revision).toBe(1);
  });

  it('stores secrets sealed, records keyVersion and audit rows, and never returns the value', async () => {
    const metadata = await patchViaApp({
      aiModelList: [{ baseURL: 'https://example.invalid', key: 'provider-a', title: 'Provider A' }],
    });
    expect(metadata.statusCode).toBe(200);

    const put = await app.inject({
      headers: { ...MUTATION_HEADERS, 'Idempotency-Key': 'pg-secret-1' },
      method: 'PUT',
      payload: { providers: [{ apiKey: MARKER, providerKey: 'provider-a' }] },
      url: '/api/settings/secrets/ai-providers',
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(MARKER);

    cipher.keyVersion = 2;
    const rotated = await app.inject({
      headers: MUTATION_HEADERS,
      method: 'PUT',
      payload: { providers: [{ apiKey: MARKER, providerKey: 'provider-a' }] },
      url: '/api/settings/secrets/ai-providers',
    });
    expect(rotated.statusCode).toBe(200);

    const secretRows = await handle.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.userId, TEST_USER_ID), eq(secrets.kind, 'ai_provider')));
    expect(secretRows).toHaveLength(1);
    expect(secretRows[0].ref).toBe('provider-a');
    expect(secretRows[0].keyVersion).toBe(2);
    expect(Buffer.from(secretRows[0].ciphertext).toString('utf8')).not.toContain(MARKER);
    expect(Buffer.from(secretRows[0].ciphertext).includes(Buffer.from(MARKER, 'utf8'))).toBe(false);

    const audits = await handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorId, TEST_USER_ID));
    const actions = audits.map((row) => row.action).sort();
    expect(actions).toContain('secret_created');
    expect(actions).toContain('secret_rotated');
    expect(JSON.stringify(audits)).not.toContain(MARKER);

    const keys = await handle.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.userId, TEST_USER_ID));
    expect(keys.some((row) => row.key === 'pg-secret-1' && row.scope === 'secrets.ai-providers.put')).toBe(true);
    expect(JSON.stringify(keys)).not.toContain(MARKER);

    const status = await app.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/secrets/status' });
    expect(status.statusCode).toBe(200);
    expect(status.body).not.toContain(MARKER);
    const statusData = bodyOf(status).data as Array<Record<string, unknown>>;
    expect(statusData).toHaveLength(1);
    expect(statusData[0].ref).toBe('provider-a');
    expect(statusData[0].label).toBe('Provider A');
    expect(typeof statusData[0].updatedAt).toBe('number');
  });

  it('isolates users: a second user sees none of the first user settings or secrets', async () => {
    const store = createDrizzleSettingsStore(() => handle.db);
    const secondApp = await createSettingsTestApp(
      { cipher, store },
      {
        verifySession: async () => ({ ...TEST_PRINCIPAL, sessionId: 'second-session', userId: SECOND_USER_ID }),
      },
    );
    try {
      const read = await secondApp.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
      expect(bodyOf(read)).toEqual({ data: { revision: 0, settings: {} }, ok: true });
      const status = await secondApp.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/secrets/status' });
      expect(bodyOf(status).data).toEqual([]);
    } finally {
      await secondApp.close();
    }
  });

  it('keeps health answering while the settings routes are registered in buildApp', async () => {
    // buildApp registers the production settings block; with stub
    // verifiers the health routes must still answer (the settings
    // block must not break the frozen foundation wiring).
    const config = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'development', PUBLIC_BASE_URL: TEST_ORIGIN });
    const prodApp = await buildApp({
      config,
      pool: null,
      verifyCsrf: testVerifyCsrf,
      verifySession: async () => TEST_PRINCIPAL,
      version: 'test',
    });
    try {
      const live = await prodApp.inject({ method: 'GET', url: '/api/health/live' });
      expect(live.statusCode).toBe(200);
    } finally {
      await prodApp.close();
    }
  });
});
