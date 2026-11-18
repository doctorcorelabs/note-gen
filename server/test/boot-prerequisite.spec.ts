// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the SETUP_TOKEN boot prerequisite wiring (desain-auth.md
// section 2.2; 30-F4-4 / 02-U1). server.ts must refuse boot when the
// database holds no accounts and no setup token of sufficient length
// is configured, must boot when accounts exist regardless of the
// token flags, and must warn and continue when the prerequisite
// cannot be checked (no usable database, or a database error such as
// an unmigrated database), so health checks keep reporting readiness
// honestly. These tests pin enforceSetupBootPrerequisite, the helper
// main() calls before buildApp; they do not change the setup endpoint
// itself. Flags only, never secret values, reach this module.

import { describe, expect, it } from 'vitest';
import { enforceSetupBootPrerequisite, enforceSingleAccountBootPrerequisite } from '../src/server.js';
import type { SetupPrerequisiteFlags } from '../src/auth/context.js';
import { FakeAuthStore } from './auth/fake-store.js';

const NO_TOKEN: SetupPrerequisiteFlags = { setupTokenConfigured: false, setupTokenLengthOk: false };
const SHORT_TOKEN: SetupPrerequisiteFlags = { setupTokenConfigured: true, setupTokenLengthOk: false };
const GOOD_TOKEN: SetupPrerequisiteFlags = { setupTokenConfigured: true, setupTokenLengthOk: true };

class ThrowingStore extends FakeAuthStore {
  async getUserCount(): Promise<number> {
    throw new Error('relation "users" does not exist');
  }
}

async function seedOneUser(store: FakeAuthStore): Promise<void> {
  await store.createFirstAccount({
    email: 'operator@example.test',
    passwordHash: 'not-a-real-hash',
    workspaceName: 'Workspace',
    now: new Date(0),
    ip: null,
    userAgent: null,
  });
}

describe('enforceSetupBootPrerequisite', () => {
  it('refuses boot when no accounts exist and no setup token is configured', async () => {
    const warnings: string[] = [];
    const outcome = await enforceSetupBootPrerequisite(new FakeAuthStore(), NO_TOKEN, (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('refused');
    expect(warnings).toEqual([]);
  });

  it('refuses boot when no accounts exist and the setup token is too short', async () => {
    const warnings: string[] = [];
    const outcome = await enforceSetupBootPrerequisite(new FakeAuthStore(), SHORT_TOKEN, (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('refused');
    expect(warnings).toEqual([]);
  });

  it('proceeds when no accounts exist and a sufficient setup token is configured', async () => {
    const warnings: string[] = [];
    const outcome = await enforceSetupBootPrerequisite(new FakeAuthStore(), GOOD_TOKEN, (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('proceed');
    expect(warnings).toEqual([]);
  });

  it('proceeds when accounts exist even without a setup token', async () => {
    const store = new FakeAuthStore();
    await seedOneUser(store);
    expect(await store.getUserCount()).toBe(1);
    const warnings: string[] = [];
    const outcome = await enforceSetupBootPrerequisite(store, NO_TOKEN, (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('proceed');
    expect(warnings).toEqual([]);
  });

  it('warns and proceeds when there is no usable database store', async () => {
    const warnings: string[] = [];
    const outcome = await enforceSetupBootPrerequisite(null, NO_TOKEN, (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('proceed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SETUP_TOKEN');
  });

  it('warns and proceeds when the user-count query fails, without error detail', async () => {
    const warnings: string[] = [];
    const outcome = await enforceSetupBootPrerequisite(new ThrowingStore(), NO_TOKEN, (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('proceed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SETUP_TOKEN');
    expect(warnings[0]).not.toContain('relation "users" does not exist');
  });
});

describe('enforceSingleAccountBootPrerequisite', () => {
  it('proceeds when no accounts exist yet (first account still to be created)', async () => {
    const warnings: string[] = [];
    const outcome = await enforceSingleAccountBootPrerequisite(new FakeAuthStore(), (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('proceed');
    expect(warnings).toEqual([]);
  });

  it('proceeds when exactly one account exists', async () => {
    const store = new FakeAuthStore();
    await seedOneUser(store);
    expect(await store.getUserCount()).toBe(1);
    const warnings: string[] = [];
    const outcome = await enforceSingleAccountBootPrerequisite(store, (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('proceed');
    expect(warnings).toEqual([]);
  });

  it('refuses boot when a second account exists (for example created directly in the database)', async () => {
    const store = new FakeAuthStore();
    store.seedUser({ email: 'operator@example.test', passwordHash: 'not-a-real-hash' });
    store.seedUser({ email: 'second@example.test', passwordHash: 'not-a-real-hash' });
    expect(await store.getUserCount()).toBe(2);
    const warnings: string[] = [];
    const outcome = await enforceSingleAccountBootPrerequisite(store, (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('refused');
    expect(warnings).toEqual([]);
  });

  it('warns and proceeds when there is no usable database store', async () => {
    const warnings: string[] = [];
    const outcome = await enforceSingleAccountBootPrerequisite(null, (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('proceed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Single-account');
  });

  it('warns and proceeds when the user-count query fails, without error detail', async () => {
    const warnings: string[] = [];
    const outcome = await enforceSingleAccountBootPrerequisite(new ThrowingStore(), (message) => {
      warnings.push(message);
    });
    expect(outcome).toBe('proceed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Single-account');
    expect(warnings[0]).not.toContain('relation "users" does not exist');
  });
});
