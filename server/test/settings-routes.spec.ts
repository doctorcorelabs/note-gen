// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Settings route tests (V3-10a): GET/PATCH /api/settings and
// GET /api/settings/revision over the in-memory store. Secrets
// behavior lives in secrets-routes.spec.ts; Postgres behavior lives
// in settings-pg.spec.ts.

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { unavailableSecretCipher } from '../src/services/settings/crypto-seam.js';
import type { SettingsServiceDeps } from '../src/services/settings/settings-service.js';
import { FakeSecretCipher } from './support/fake-cipher.js';
import { MemorySettingsStore } from './support/memory-settings-store.js';
import {
  createProductionTestApp,
  createSettingsTestApp,
  denySession,
  MUTATION_HEADERS,
  SESSION_HEADERS,
} from './support/settings-test-app.js';

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
});

async function setup(deps?: Partial<SettingsServiceDeps>): Promise<{ cipher: FakeSecretCipher; store: MemorySettingsStore }> {
  const store = new MemorySettingsStore();
  const cipher = new FakeSecretCipher();
  app = await createSettingsTestApp({ cipher, store, ...deps });
  return { cipher, store };
}

function bodyOf(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

async function patchSettings(settings: Record<string, unknown>, baseRevision: number, extraHeaders: Record<string, string> = {}) {
  const response = await app!.inject({
    headers: { ...MUTATION_HEADERS, ...extraHeaders },
    method: 'PATCH',
    payload: { baseRevision, settings },
    url: '/api/settings',
  });
  return response;
}

describe('GET /api/settings', () => {
  it('returns revision 0 and an empty document for a new user', async () => {
    await setup();
    const response = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({ data: { revision: 0, settings: {} }, ok: true });
  });

  it('returns stored keys, omits absent keys, and honors the keys filter', async () => {
    await setup();
    await patchSettings({ editorViewMode: 'source', language: 'English' }, 0);
    const full = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    expect(bodyOf(full)).toEqual({
      data: { revision: 1, settings: { editorViewMode: 'source', language: 'English' } },
      ok: true,
    });
    const filtered = await app!.inject({
      headers: SESSION_HEADERS,
      method: 'GET',
      url: '/api/settings?keys=language,notStored,openTabs',
    });
    // notStored is absent (never null); openTabs is class L and never
    // appears in a settings read even when requested by name.
    expect(bodyOf(filtered)).toEqual({ data: { revision: 1, settings: { language: 'English' } }, ok: true });
  });

  it('answers 404 for the trailing-slash variant (kontrak 1.1)', async () => {
    await setup();
    const response = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/' });
    expect(response.statusCode).toBe(404);
    expect((bodyOf(response).error as Record<string, unknown>).code).toBe('not_found');
  });
});

describe('GET /api/settings/revision', () => {
  it('returns the current revision only', async () => {
    await setup();
    await patchSettings({ language: 'English' }, 0);
    const response = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/revision' });
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({ data: { revision: 1 }, ok: true });
  });
});

describe('PATCH /api/settings', () => {
  it('applies S keys, bumps the revision once, and persists across reads', async () => {
    await setup();
    const response = await patchSettings({ editorLineHeight: 1.6, language: 'English' }, 0);
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({
      data: { applied: ['editorLineHeight', 'language'], rejected: [], revision: 1 },
      ok: true,
    });
    const read = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    expect((bodyOf(read).data as Record<string, unknown>).settings).toEqual({ editorLineHeight: 1.6, language: 'English' });
  });

  it('rejects per key with the contract reasons and never fails the whole request', async () => {
    await setup();
    const response = await patchSettings(
      {
        editorShortcuts: { toggleBold: 'Mod+B' },
        language: 'English',
        madeUpKey: 1,
        openTabs: ['a'],
        s3SyncConfig: { bucket: 'x' },
      },
      0,
    );
    expect(response.statusCode).toBe(200);
    const data = bodyOf(response).data as Record<string, unknown>;
    // editorShortcuts is class S (AD-33/KEP-7) and applies.
    expect(data.applied).toEqual(['editorShortcuts', 'language']);
    expect(data.rejected).toEqual([
      { key: 'madeUpKey', reason: 'unknown_key' },
      { key: 'openTabs', reason: 'local_only' },
      { key: 's3SyncConfig', reason: 'secret_only' },
    ]);
    expect(data.revision).toBe(1);
    // The PATCH response carries key names only, never values.
    expect(response.body).not.toContain('Mod+B');
    const read = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    expect((bodyOf(read).data as Record<string, unknown>).settings).toEqual({
      editorShortcuts: { toggleBold: 'Mod+B' },
      language: 'English',
    });
  });

  it('does not bump the revision when every key is rejected', async () => {
    await setup();
    const response = await patchSettings({ openTabs: [] }, 0);
    expect(bodyOf(response).data).toEqual({ applied: [], rejected: [{ key: 'openTabs', reason: 'local_only' }], revision: 0 });
  });

  it('deletes with null, including a delete of an absent key (applied, idempotent)', async () => {
    await setup();
    await patchSettings({ language: 'English' }, 0);
    const response = await patchSettings({ language: null, primaryModel: null }, 1);
    expect(bodyOf(response).data).toEqual({ applied: ['language', 'primaryModel'], rejected: [], revision: 2 });
    const read = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    expect((bodyOf(read).data as Record<string, unknown>).settings).toEqual({});
  });

  it('requires baseRevision', async () => {
    await setup();
    const response = await app!.inject({
      headers: MUTATION_HEADERS,
      method: 'PATCH',
      payload: { settings: { language: 'English' } },
      url: '/api/settings',
    });
    expect(response.statusCode).toBe(400);
    const error = bodyOf(response).error as Record<string, unknown>;
    expect(error.code).toBe('validation_failed');
    expect(error.details).toEqual({ fields: [{ field: 'baseRevision', issue: 'must be a non-negative integer' }] });
  });

  it('rejects unknown body fields (kontrak 1.5)', async () => {
    await setup();
    const response = await app!.inject({
      headers: MUTATION_HEADERS,
      method: 'PATCH',
      payload: { baseRevision: 0, settings: {}, workspaceId: 'x' },
      url: '/api/settings',
    });
    expect(response.statusCode).toBe(400);
    expect((bodyOf(response).error as Record<string, unknown>).code).toBe('validation_failed');
  });

  it('answers 409 with current state on a stale baseRevision and applies nothing', async () => {
    await setup();
    await patchSettings({ language: 'English' }, 0);
    const response = await patchSettings({ language: 'Bahasa' }, 0);
    expect(response.statusCode).toBe(409);
    const error = bodyOf(response).error as Record<string, unknown>;
    expect(error.code).toBe('revision_conflict');
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ revision: 1, settings: { language: 'English' } });
    const read = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    expect((bodyOf(read).data as Record<string, unknown>).settings).toEqual({ language: 'English' });
  });

  it('honors Idempotency-Key: replay returns the stored response without re-executing', async () => {
    await setup();
    const first = await patchSettings({ language: 'English' }, 0, { 'Idempotency-Key': 'key-1' });
    expect(first.statusCode).toBe(200);
    const second = await patchSettings({ language: 'English' }, 0, { 'Idempotency-Key': 'key-1' });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    const revision = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/revision' });
    expect((bodyOf(revision).data as Record<string, unknown>).revision).toBe(1);
  });

  it('answers 409 idempotency_key_reused for the same key with a different request', async () => {
    await setup();
    await patchSettings({ language: 'English' }, 0, { 'Idempotency-Key': 'key-1' });
    const response = await patchSettings({ language: 'Bahasa' }, 1, { 'Idempotency-Key': 'key-1' });
    expect(response.statusCode).toBe(409);
    expect((bodyOf(response).error as Record<string, unknown>).code).toBe('idempotency_key_reused');
  });

  it('rejects an over-long idempotency key', async () => {
    await setup();
    const response = await patchSettings({ language: 'English' }, 0, { 'Idempotency-Key': 'k'.repeat(129) });
    expect(response.statusCode).toBe(400);
    expect((bodyOf(response).error as Record<string, unknown>).code).toBe('validation_failed');
  });

  it('rejects malformed aiModelList values as invalid_value', async () => {
    await setup();
    const duplicate = await patchSettings(
      {
        aiModelList: [
          { key: 'provider-a', title: 'A' },
          { key: 'provider-a', title: 'A again' },
        ],
      },
      0,
    );
    expect(duplicate.statusCode).toBe(200);
    expect((bodyOf(duplicate).data as Record<string, unknown>).rejected).toEqual([
      { key: 'aiModelList', reason: 'invalid_value' },
    ]);
    const notArray = await patchSettings({ aiModelList: 'nope' }, 0);
    expect((bodyOf(notArray).data as Record<string, unknown>).rejected).toEqual([
      { key: 'aiModelList', reason: 'invalid_value' },
    ]);
  });

  it('rejects aiModelList entries carrying credential fields as secret_only, storing nothing', async () => {
    await setup();
    const response = await patchSettings(
      { aiModelList: [{ apiKey: 'MARKER-SECRET-VALUE', key: 'provider-a', title: 'A' }] },
      0,
    );
    expect(response.statusCode).toBe(200);
    expect((bodyOf(response).data as Record<string, unknown>).rejected).toEqual([
      { key: 'aiModelList', reason: 'secret_only' },
    ]);
    expect(response.body).not.toContain('MARKER-SECRET-VALUE');
    const read = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    expect((bodyOf(read).data as Record<string, unknown>).settings).toEqual({});
  });

  it('stores aiModelList metadata and enriches reads with hasApiKey and updatedAt', async () => {
    await setup();
    await patchSettings({ aiModelList: [{ baseURL: 'https://example.invalid', key: 'provider-a', title: 'Provider A' }] }, 0);
    const read = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    const settings = (bodyOf(read).data as Record<string, unknown>).settings as Record<string, unknown>;
    expect(settings.aiModelList).toEqual([
      { baseURL: 'https://example.invalid', hasApiKey: false, key: 'provider-a', title: 'Provider A', updatedAt: null },
    ]);
  });
});

describe('settings auth enforcement (frozen hook)', () => {
  it('answers 401 without a verified session', async () => {
    const store = new MemorySettingsStore();
    app = await createSettingsTestApp({ cipher: new FakeSecretCipher(), store }, { verifySession: denySession });
    const response = await app.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(401);
    expect((bodyOf(response).error as Record<string, unknown>).code).toBe('unauthenticated');
  });

  it('answers 403 csrf_invalid without a CSRF token and 403 origin_rejected for a wrong origin', async () => {
    await setup();
    const noCsrf = await app!.inject({
      headers: { ...SESSION_HEADERS, origin: 'http://localhost:3001' },
      method: 'PATCH',
      payload: { baseRevision: 0, settings: {} },
      url: '/api/settings',
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((bodyOf(noCsrf).error as Record<string, unknown>).code).toBe('csrf_invalid');
    const badOrigin = await app!.inject({
      headers: { ...SESSION_HEADERS, origin: 'https://evil.invalid', 'x-csrf-token': 'good-csrf-token' },
      method: 'PATCH',
      payload: { baseRevision: 0, settings: {} },
      url: '/api/settings',
    });
    expect(badOrigin.statusCode).toBe(403);
    expect((bodyOf(badOrigin).error as Record<string, unknown>).code).toBe('origin_rejected');
  });
});

describe('production app.ts settings block (smoke)', () => {
  it('registers the routes and fails closed without a database', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      app = await createProductionTestApp();
      const response = await app.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
      expect(response.statusCode).toBe(503);
      expect((bodyOf(response).error as Record<string, unknown>).code).toBe('service_unavailable');
    } finally {
      if (saved === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = saved;
      }
    }
  });

  it('exposes the unavailable cipher seam: secret writes fail closed, nothing stored', async () => {
    // The production deps use unavailableSecretCipher until V3-10b
    // lands; the seam itself must throw 503, never store plaintext.
    await expect(unavailableSecretCipher.seal(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
  });
});
