// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Single-account enforcement pins (R24-DEC1; DA-22-01/02/03,
// S-P0-13/S-P0-14/S-P0-15, DA-22-07). The file layer shares one
// filesystem root across accounts, so a single-account deployment
// must prove, at every layer, that no second account can appear:
//
// - Boot config refuses a non-closed REGISTRATION_MODE (pinned in
//   config.spec.ts); route registration refuses a programmatically
//   built non-closed auth context (pinned here).
// - POST /api/auth/register always answers 404 and creates nothing.
// - POST /api/auth/setup answers 404 once the first account exists.
// - Boot refuses when the database already holds more than one
//   account (pinned in boot-prerequisite.spec.ts).
// - No second account-creation path exists in server code: the only
//   insert into the users table is the first-account setup, and the
//   admin routes stay unwired (structural guards pinned here).
//
// These tests pin the DECISION, not just current behavior. Removing
// any of them requires the multi-account filesystem isolation plus
// a recorded decision; a red test here after a future change means
// the change reopened the second-account path, not that the test
// is stale.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TEST_SETUP_TOKEN,
  bodyOf,
  buildTestApp,
  makeTestAuth,
  publicHeaders,
} from './auth/helpers.js';

const TEST_PASSWORD = 'not-a-real-password-123';

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

describe('single-account HTTP surface', () => {
  it('POST /api/auth/register answers 404 and creates no account', async () => {
    const fixture = makeTestAuth();
    app = await buildTestApp(fixture.auth);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { ...publicHeaders(), 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'new@example.invalid', password: TEST_PASSWORD }),
    });
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error?.code).toBe('not_found');
    expect(await fixture.store.getUserCount()).toBe(0);
  });

  it('POST /api/auth/setup answers 404 once the first account exists, and the count stays one', async () => {
    const fixture = makeTestAuth();
    app = await buildTestApp(fixture.auth);
    await fixture.store.createFirstAccount({
      email: 'operator@example.test',
      passwordHash: await fixture.hasher.hash(TEST_PASSWORD),
      workspaceName: 'Workspace',
      now: new Date(0),
      ip: null,
      userAgent: null,
    });
    expect(await fixture.store.getUserCount()).toBe(1);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { ...publicHeaders(), 'content-type': 'application/json' },
      payload: JSON.stringify({
        setupToken: TEST_SETUP_TOKEN,
        email: 'second@example.invalid',
        password: TEST_PASSWORD,
        workspaceName: 'Second',
      }),
    });
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error?.code).toBe('not_found');
    expect(await fixture.store.getUserCount()).toBe(1);
  });
});

describe('single-account registration guard', () => {
  it('refuses to build the app with an invitation-mode auth context', async () => {
    const fixture = makeTestAuth({ registrationMode: 'invitation' });
    await expect(buildTestApp(fixture.auth)).rejects.toThrow(/REGISTRATION_MODE must be closed/);
  });

  it('refuses to build the app with an open-mode auth context', async () => {
    const fixture = makeTestAuth({ registrationMode: 'open' });
    await expect(buildTestApp(fixture.auth)).rejects.toThrow(/REGISTRATION_MODE must be closed/);
  });
});

describe('single-account structural guards', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

  async function listTsFiles(dir: string): Promise<string[]> {
    const found: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...(await listTsFiles(full)));
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        found.push(full);
      }
    }
    return found;
  }

  it('has exactly one account-creation path in server code: first-account setup', async () => {
    const creators: string[] = [];
    for (const file of await listTsFiles(srcDir)) {
      const text = await readFile(file, 'utf8');
      if (text.includes('insert(users)')) {
        creators.push(relative(srcDir, file).split(sep).join('/'));
      }
    }
    expect(creators.sort()).toEqual(['auth/store.ts']);
  });

  it('keeps the admin routes unwired: the generated route index never references them', async () => {
    const index = await readFile(join(srcDir, 'routes-generated.ts'), 'utf8');
    expect(index).not.toContain('auth-admin');
    expect(index).not.toContain('registerAuthAdminRoutes');
  });
});
