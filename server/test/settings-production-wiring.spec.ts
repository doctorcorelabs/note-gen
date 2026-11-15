// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Production cipher wiring (V3-10b integrator, W7/W8): the factory
// createProductionSettingsDeps must supply the real V3-10b adapter
// when ENCRYPTION_KEY is configured, and keep the fail-closed
// placeholder otherwise. Keys here are generated fresh per run and
// exist only in memory; no key value is asserted on, logged, or
// written anywhere.

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductionSettingsDeps } from '../src/services/settings/index.js';

const KEY_VARS = [
  'ENCRYPTION_KEY',
  'SECRETS_ENCRYPTION_KEY',
  'ENCRYPTION_KEY_VERSION',
  'ENCRYPTION_PREVIOUS_KEYS',
] as const;

let saved: Partial<Record<(typeof KEY_VARS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const name of KEY_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of KEY_VARS) {
    const value = saved[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('production settings cipher wiring', () => {
  it('seals with the real adapter and opens through a fresh service when a key is configured', async () => {
    process.env['ENCRYPTION_KEY'] = randomBytes(32).toString('hex');
    const marker = `wiring-marker-${randomBytes(8).toString('hex')}`;
    const plaintext = Buffer.from(marker, 'utf8');
    const deps = createProductionSettingsDeps();
    expect(deps.cipher.keyVersion).toBe(1);
    const sealed = await deps.cipher.seal(plaintext);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.nonce.length).toBe(12);
    expect(Buffer.from(sealed.ciphertext).includes(plaintext)).toBe(false);
    expect(JSON.stringify(sealed)).not.toContain(marker);
    const second = await deps.cipher.seal(plaintext);
    expect(Buffer.from(second.nonce).equals(Buffer.from(sealed.nonce))).toBe(false);
    expect(Buffer.from(second.ciphertext).equals(Buffer.from(sealed.ciphertext))).toBe(false);
    const fresh = createProductionSettingsDeps();
    const opened = await fresh.cipher.open(sealed);
    expect(Buffer.from(opened).toString('utf8')).toBe(marker);
  });

  it('falls back to the fail-closed placeholder when no key is configured', async () => {
    const deps = createProductionSettingsDeps();
    expect(deps.cipher.keyVersion).toBe(0);
    await expect(deps.cipher.seal(Buffer.from('x', 'utf8'))).rejects.toThrow(
      'Secret encryption is not configured.',
    );
    await expect(
      deps.cipher.open({ ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(0), keyVersion: 0 }),
    ).rejects.toThrow('Secret encryption is not configured.');
  });

  it('falls back to the fail-closed placeholder when the configured key is invalid', async () => {
    process.env['ENCRYPTION_KEY'] = 'too-short';
    const deps = createProductionSettingsDeps();
    expect(deps.cipher.keyVersion).toBe(0);
    await expect(deps.cipher.seal(Buffer.from('x', 'utf8'))).rejects.toThrow(
      'Secret encryption is not configured.',
    );
  });

  it('accepts the legacy key name as a fallback', async () => {
    process.env['SECRETS_ENCRYPTION_KEY'] = randomBytes(32).toString('hex');
    const deps = createProductionSettingsDeps();
    expect(deps.cipher.keyVersion).toBe(1);
    const opened = await deps.cipher.open(
      await deps.cipher.seal(Buffer.from('legacy-ok', 'utf8')),
    );
    expect(Buffer.from(opened).toString('utf8')).toBe('legacy-ok');
  });
});
