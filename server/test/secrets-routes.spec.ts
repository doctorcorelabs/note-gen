// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Secrets route tests (V3-10a): status, PUT/DELETE ai-providers, the
// orphan sweep, rotation recording, and the AD-16 guarantee that no
// secret value ever appears in a response. The marker value below is
// a test fixture marker, not a credential; every response body in
// this file is asserted not to contain it. The fake cipher stands in
// for the V3-10b envelope implementation at the seam.

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeSecretBundle,
  SECRET_KIND_AI_PROVIDER,
  unavailableSecretCipher,
} from '../src/services/settings/crypto-seam.js';
import { FakeSecretCipher } from './support/fake-cipher.js';
import { MemorySettingsStore } from './support/memory-settings-store.js';
import {
  createSettingsTestApp,
  MUTATION_HEADERS,
  SESSION_HEADERS,
  TEST_USER_ID,
} from './support/settings-test-app.js';

const MARKER = 'MARKER-SECRET-VALUE-7F3A9C';
const MARKER_2 = 'MARKER-WEBSEARCH-VALUE-7F3A9C';

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
});

async function setup(): Promise<{ cipher: FakeSecretCipher; store: MemorySettingsStore }> {
  const store = new MemorySettingsStore();
  const cipher = new FakeSecretCipher();
  app = await createSettingsTestApp({ cipher, store });
  return { cipher, store };
}

function bodyOf(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

async function setMetadata(entries: Array<Record<string, unknown>>): Promise<void> {
  const revisionResponse = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/revision' });
  const revision = (bodyOf(revisionResponse).data as { revision: number }).revision;
  const response = await app!.inject({
    headers: MUTATION_HEADERS,
    method: 'PATCH',
    payload: { baseRevision: revision, settings: { aiModelList: entries } },
    url: '/api/settings',
  });
  expect(response.statusCode).toBe(200);
  expect((bodyOf(response).data as Record<string, unknown>).applied).toEqual(['aiModelList']);
}

async function putProviders(providers: unknown[], extraHeaders: Record<string, string> = {}) {
  return app!.inject({
    headers: { ...MUTATION_HEADERS, ...extraHeaders },
    method: 'PUT',
    payload: { providers },
    url: '/api/settings/secrets/ai-providers',
  });
}

async function storedBundle(store: MemorySettingsStore, cipher: FakeSecretCipher, ref: string) {
  const row = await store.transact(TEST_USER_ID, async (tx) => tx.getSecret(SECRET_KIND_AI_PROVIDER, ref));
  if (row === null) {
    return null;
  }
  const opened = await cipher.open({ ciphertext: row.ciphertext, keyVersion: row.keyVersion, nonce: row.nonce });
  return { bundle: decodeSecretBundle(opened), row };
}

describe('PUT /api/settings/secrets/ai-providers', () => {
  it('stores a secret without ever returning its value', async () => {
    const { store, cipher } = await setup();
    await setMetadata([{ baseURL: 'https://example.invalid', key: 'provider-a', title: 'Provider A' }]);
    const response = await putProviders([{ apiKey: MARKER, providerKey: 'provider-a' }]);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(MARKER);
    const data = bodyOf(response).data as Record<string, unknown>;
    expect(data.updated).toHaveLength(1);
    const [entry] = data.updated as Array<Record<string, unknown>>;
    expect(entry.providerKey).toBe('provider-a');
    expect(entry.hasApiKey).toBe(true);
    expect(typeof entry.updatedAt).toBe('number');

    const status = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/secrets/status' });
    expect(status.statusCode).toBe(200);
    expect(status.body).not.toContain(MARKER);
    const statusData = bodyOf(status).data as Array<Record<string, unknown>>;
    expect(statusData).toHaveLength(1);
    expect(statusData[0].kind).toBe('ai_provider');
    expect(statusData[0].ref).toBe('provider-a');
    expect(statusData[0].label).toBe('Provider A');
    expect(statusData[0].lastUsedAt).toBeNull();
    expect(typeof statusData[0].updatedAt).toBe('number');

    const settings = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings' });
    expect(settings.body).not.toContain(MARKER);
    const settingsData = bodyOf(settings).data as Record<string, unknown>;
    const list = (settingsData.settings as Record<string, unknown>).aiModelList as Array<Record<string, unknown>>;
    expect(list[0].hasApiKey).toBe(true);
    expect(list[0]).not.toHaveProperty('apiKey');

    // The stored bytes are the cipher output, not the marker.
    const stored = await storedBundle(store, cipher, 'provider-a');
    expect(stored).not.toBeNull();
    expect(stored!.row.ciphertext.toString('utf8')).not.toContain(MARKER);
    expect(stored!.bundle.apiKey).toBe(MARKER);
  });

  it('merges patches: absent leaves, value replaces, null deletes the field', async () => {
    const { store, cipher } = await setup();
    await setMetadata([{ key: 'provider-a', title: 'Provider A' }]);
    await putProviders([{ apiKey: MARKER, providerKey: 'provider-a', webSearchApiKey: MARKER_2 }]);
    await putProviders([{ providerKey: 'provider-a', webSearchApiKey: 'MARKER-WEBSEARCH-NEW-7F3A9C' }]);
    let stored = await storedBundle(store, cipher, 'provider-a');
    expect(stored!.bundle).toEqual({ apiKey: MARKER, webSearchApiKey: 'MARKER-WEBSEARCH-NEW-7F3A9C' });
    await putProviders([{ apiKey: null, providerKey: 'provider-a' }]);
    stored = await storedBundle(store, cipher, 'provider-a');
    expect(stored!.bundle).toEqual({ webSearchApiKey: 'MARKER-WEBSEARCH-NEW-7F3A9C' });
  });

  it('deletes the row when the merged bundle becomes empty', async () => {
    const { store, cipher } = await setup();
    await setMetadata([{ key: 'provider-a', title: 'Provider A' }]);
    await putProviders([{ apiKey: MARKER, providerKey: 'provider-a' }]);
    const response = await putProviders([{ apiKey: null, providerKey: 'provider-a' }]);
    expect(response.statusCode).toBe(200);
    expect((bodyOf(response).data as Record<string, unknown>).updated).toEqual([
      { hasApiKey: false, providerKey: 'provider-a', updatedAt: expect.any(Number) },
    ]);
    expect(await storedBundle(store, cipher, 'provider-a')).toBeNull();
    const status = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/secrets/status' });
    expect(bodyOf(status).data).toEqual([]);
  });

  it('answers 400 for a provider without metadata, storing nothing', async () => {
    const { store, cipher } = await setup();
    await setMetadata([{ key: 'provider-a', title: 'Provider A' }]);
    const response = await putProviders([{ apiKey: MARKER, providerKey: 'provider-unknown' }]);
    expect(response.statusCode).toBe(400);
    expect((bodyOf(response).error as Record<string, unknown>).code).toBe('validation_failed');
    expect(response.body).not.toContain(MARKER);
    expect(await storedBundle(store, cipher, 'provider-unknown')).toBeNull();
  });

  it('rejects unknown fields, empty arrays, and duplicate provider keys', async () => {
    await setup();
    await setMetadata([{ key: 'provider-a', title: 'Provider A' }]);
    const unknownField = await putProviders([{ apiKey: MARKER, extra: 1, providerKey: 'provider-a' }]);
    expect(unknownField.statusCode).toBe(400);
    const empty = await putProviders([]);
    expect(empty.statusCode).toBe(400);
    const duplicate = await putProviders([
      { apiKey: MARKER, providerKey: 'provider-a' },
      { apiKey: MARKER, providerKey: 'provider-a' },
    ]);
    expect(duplicate.statusCode).toBe(400);
    const topLevel = await app!.inject({
      headers: MUTATION_HEADERS,
      method: 'PUT',
      payload: { providers: [{ apiKey: MARKER, providerKey: 'provider-a' }], surprise: true },
      url: '/api/settings/secrets/ai-providers',
    });
    expect(topLevel.statusCode).toBe(400);
  });

  it('records key rotation: keyVersion on the row and secret_rotated in the audit trail', async () => {
    const { store, cipher } = await setup();
    await setMetadata([{ key: 'provider-a', title: 'Provider A' }]);
    await putProviders([{ apiKey: MARKER, providerKey: 'provider-a' }]);
    cipher.keyVersion = 2;
    await putProviders([{ apiKey: MARKER, providerKey: 'provider-a' }]);
    const stored = await storedBundle(store, cipher, 'provider-a');
    expect(stored!.row.keyVersion).toBe(2);
    const actions = store.auditEvents.map((event) => event.action);
    expect(actions).toEqual(['secret_created', 'secret_rotated']);
    // Audit metadata never carries the value.
    expect(JSON.stringify(store.auditEvents)).not.toContain(MARKER);
    for (const event of store.auditEvents) {
      expect(event.targetType).toBe('secret');
      expect(event.targetId).toBe('provider-a');
    }
  });

  it('honors Idempotency-Key without re-executing', async () => {
    const { store } = await setup();
    await setMetadata([{ key: 'provider-a', title: 'Provider A' }]);
    const first = await putProviders([{ apiKey: MARKER, providerKey: 'provider-a' }], { 'Idempotency-Key': 'sec-1' });
    const second = await putProviders([{ apiKey: MARKER, providerKey: 'provider-a' }], { 'Idempotency-Key': 'sec-1' });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(store.auditEvents).toHaveLength(1);
    const reused = await putProviders([{ apiKey: 'OTHER-MARKER', providerKey: 'provider-a' }], { 'Idempotency-Key': 'sec-1' });
    expect(reused.statusCode).toBe(409);
    expect((bodyOf(reused).error as Record<string, unknown>).code).toBe('idempotency_key_reused');
  });

  it('fails closed with 503 when no cipher is wired, storing nothing', async () => {
    const store = new MemorySettingsStore();
    app = await createSettingsTestApp({ cipher: unavailableSecretCipher, store });
    await setMetadata([{ key: 'provider-a', title: 'Provider A' }]);
    const response = await putProviders([{ apiKey: MARKER, providerKey: 'provider-a' }]);
    expect(response.statusCode).toBe(503);
    expect((bodyOf(response).error as Record<string, unknown>).code).toBe('service_unavailable');
    expect(response.body).not.toContain(MARKER);
    const row = await store.transact(TEST_USER_ID, async (tx) => tx.getSecret(SECRET_KIND_AI_PROVIDER, 'provider-a'));
    expect(row).toBeNull();
  });
});

describe('DELETE /api/settings/secrets/ai-providers/:providerKey', () => {
  it('deletes the bundle, is idempotent, and answers 404 for unknown metadata', async () => {
    const { store } = await setup();
    await setMetadata([{ key: 'provider-a', title: 'Provider A' }]);
    await putProviders([{ apiKey: MARKER, providerKey: 'provider-a' }]);
    const first = await app!.inject({
      headers: MUTATION_HEADERS,
      method: 'DELETE',
      url: '/api/settings/secrets/ai-providers/provider-a',
    });
    expect(first.statusCode).toBe(200);
    expect(bodyOf(first).data).toEqual({ deleted: true, hasApiKey: false, providerKey: 'provider-a' });
    const second = await app!.inject({
      headers: MUTATION_HEADERS,
      method: 'DELETE',
      url: '/api/settings/secrets/ai-providers/provider-a',
    });
    expect(second.statusCode).toBe(200);
    expect(bodyOf(second).data).toEqual({ deleted: false, hasApiKey: false, providerKey: 'provider-a' });
    const unknown = await app!.inject({
      headers: MUTATION_HEADERS,
      method: 'DELETE',
      url: '/api/settings/secrets/ai-providers/provider-unknown',
    });
    expect(unknown.statusCode).toBe(404);
    expect((bodyOf(unknown).error as Record<string, unknown>).code).toBe('not_found');
    expect(store.auditEvents.map((event) => event.action)).toEqual(['secret_created', 'secret_deleted']);
  });
});

describe('orphan sweep via PATCH aiModelList', () => {
  it('deletes secrets whose provider entry is removed, and all secrets when aiModelList is deleted', async () => {
    const { store, cipher } = await setup();
    await setMetadata([
      { key: 'provider-a', title: 'A' },
      { key: 'provider-b', title: 'B' },
    ]);
    await putProviders([
      { apiKey: MARKER, providerKey: 'provider-a' },
      { apiKey: MARKER_2, providerKey: 'provider-b' },
    ]);
    await setMetadata([{ key: 'provider-b', title: 'B' }]);
    expect(await storedBundle(store, cipher, 'provider-a')).toBeNull();
    expect(await storedBundle(store, cipher, 'provider-b')).not.toBeNull();

    const revisionResponse = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/revision' });
    const revision = (bodyOf(revisionResponse).data as { revision: number }).revision;
    const response = await app!.inject({
      headers: MUTATION_HEADERS,
      method: 'PATCH',
      payload: { baseRevision: revision, settings: { aiModelList: null } },
      url: '/api/settings',
    });
    expect(response.statusCode).toBe(200);
    expect(await storedBundle(store, cipher, 'provider-b')).toBeNull();
    const status = await app!.inject({ headers: SESSION_HEADERS, method: 'GET', url: '/api/settings/secrets/status' });
    expect(bodyOf(status).data).toEqual([]);
  });
});

describe('reserved general secrets forms', () => {
  it('does not register the Fase 2 general secrets routes (kontrak 8.6)', async () => {
    await setup();
    const put = await app!.inject({
      headers: MUTATION_HEADERS,
      method: 'PUT',
      payload: { value: 'x' },
      url: '/api/settings/secrets/git',
    });
    expect(put.statusCode).toBe(404);
    const del = await app!.inject({
      headers: MUTATION_HEADERS,
      method: 'DELETE',
      url: '/api/settings/secrets/git/main',
    });
    expect(del.statusCode).toBe(404);
  });
});
