// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for production auth-context construction from the
// environment (G11b): a blank or whitespace-only encryption key
// value counts as absent per name, matching key-ring present()
// semantics, so a whitespace-only canonical value cannot shadow a
// valid alias or reach the seal path as if configured.

import { afterEach, describe, expect, it } from 'vitest';
import { createAuthContextFromConfig } from '../../src/auth/context.js';
import { TEST_ENCRYPTION_KEY, testConfig } from './helpers.js';

const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) {
    savedEnv[name] = process.env[name];
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  for (const name of Object.keys(savedEnv)) {
    delete savedEnv[name];
  }
});

describe('createAuthContextFromConfig encryption key resolution', () => {
  it('falls back to the alias when the canonical value is whitespace-only', async () => {
    setEnv('ENCRYPTION_KEY', '   ');
    setEnv('SECRETS_ENCRYPTION_KEY', TEST_ENCRYPTION_KEY);
    const context = createAuthContextFromConfig(testConfig(), { store: null });
    try {
      expect(context.encryptionKey).toBe(TEST_ENCRYPTION_KEY);
    } finally {
      await context.close();
    }
  });

  it('treats a whitespace-only key with no alias as absent', async () => {
    setEnv('ENCRYPTION_KEY', '   ');
    setEnv('SECRETS_ENCRYPTION_KEY', undefined);
    const context = createAuthContextFromConfig(testConfig(), { store: null });
    try {
      expect(context.encryptionKey).toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it('keeps a defined blank override absent without falling through to the environment', async () => {
    setEnv('ENCRYPTION_KEY', TEST_ENCRYPTION_KEY);
    setEnv('SECRETS_ENCRYPTION_KEY', undefined);
    const context = createAuthContextFromConfig(testConfig(), { encryptionKey: '', store: null });
    try {
      expect(context.encryptionKey).toBeUndefined();
    } finally {
      await context.close();
    }
  });
});
