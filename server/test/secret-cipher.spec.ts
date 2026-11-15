// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the SecretCipher seam adapter (V3-10bR). All key material
// below is derived from clearly marked TEST-ONLY fixture strings; no
// real key is used anywhere in this file.
//
// The mirror interfaces below copy the SHAPE of V3-10a's seam
// verbatim from server/src/services/settings/crypto-seam.ts at
// origin/web-settings-backend c15ee6ae. That file does not exist on
// this branch, so the mirror is the compile-time pin: if V3-10a
// changes its seam, the integrator re-verifies this test against the
// merged tree. The adapter must stay assignable to the real seam.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CryptoError,
  CryptoService,
  CryptoServiceSecretCipher,
  KeyRing,
  createSecretCipherFromEnv,
  type SealedSecretBytes,
} from '../src/lib/crypto/index.js';
import { createCryptoServiceFromEnv } from '../src/lib/crypto.js';

interface MirrorSealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

interface MirrorSecretCipher {
  readonly keyVersion: number;
  seal(plaintext: Uint8Array): Promise<MirrorSealedSecret>;
  open(sealed: MirrorSealedSecret): Promise<Uint8Array>;
}

function fixtureKey(marker: string): Buffer {
  return createHash('sha256').update(`v3-10b TEST-ONLY fixture key: ${marker}`).digest();
}

function ringV1(): KeyRing {
  return new KeyRing([{ version: 1, key: fixtureKey('one') }], 1);
}

function adapterFor(ring: KeyRing): { service: CryptoService; cipher: CryptoServiceSecretCipher } {
  const service = new CryptoService(ring);
  return { service, cipher: new CryptoServiceSecretCipher(service) };
}

const PLAINTEXT = 'test-only adapter secret value 9d2e41';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('adapter round-trip', () => {
  it('seals and opens through the async seam shape', async () => {
    const { cipher } = adapterFor(ringV1());
    const sealed = await cipher.seal(encoder.encode(PLAINTEXT));
    expect(cipher.keyVersion).toBe(1);
    expect(sealed.keyVersion).toBe(1);
    expect(decoder.decode(await cipher.open(sealed))).toBe(PLAINTEXT);
  });

  it('returns exactly the three secrets-table columns', async () => {
    const { cipher } = adapterFor(ringV1());
    const sealed = await cipher.seal(encoder.encode(PLAINTEXT));
    expect(Object.keys(sealed).sort()).toEqual(['ciphertext', 'keyVersion', 'nonce']);
    expect(Buffer.isBuffer(sealed.ciphertext)).toBe(true);
    expect(Buffer.isBuffer(sealed.nonce)).toBe(true);
    expect(sealed.nonce.length).toBe(12);
  });

  it('uses a fresh nonce per seal', async () => {
    const { cipher } = adapterFor(ringV1());
    const first = await cipher.seal(encoder.encode(PLAINTEXT));
    const second = await cipher.seal(encoder.encode(PLAINTEXT));
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('accepts a plain Uint8Array that is not a Buffer', async () => {
    const { cipher } = adapterFor(ringV1());
    const input = new Uint8Array(encoder.encode(PLAINTEXT));
    expect(Buffer.isBuffer(input)).toBe(false);
    const sealed = await cipher.seal(input);
    expect(decoder.decode(await cipher.open(sealed))).toBe(PLAINTEXT);
  });

  it('interchanges with CryptoService encrypt/decrypt', async () => {
    const { service, cipher } = adapterFor(ringV1());
    const parts = service.encrypt(PLAINTEXT);
    const asRow: SealedSecretBytes = {
      ciphertext: parts.ciphertext,
      nonce: parts.nonce,
      keyVersion: parts.keyVersion,
    };
    expect(decoder.decode(await cipher.open(asRow))).toBe(PLAINTEXT);
    const sealed = await cipher.seal(encoder.encode(PLAINTEXT));
    expect(
      service.decryptToString({
        formatVersion: 1,
        keyVersion: sealed.keyVersion,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
      }),
    ).toBe(PLAINTEXT);
  });
});

describe('adapter failures', () => {
  it('rejects tampered ciphertext, tag, and nonce', async () => {
    const { cipher } = adapterFor(ringV1());
    const sealed = await cipher.seal(encoder.encode(PLAINTEXT));
    const tamperedBody = Buffer.from(sealed.ciphertext);
    tamperedBody[5] ^= 0xff;
    await expect(cipher.open({ ...sealed, ciphertext: tamperedBody })).rejects.toBeInstanceOf(CryptoError);
    const tamperedTag = Buffer.from(sealed.ciphertext);
    tamperedTag[tamperedTag.length - 1] ^= 0x01;
    await expect(cipher.open({ ...sealed, ciphertext: tamperedTag })).rejects.toBeInstanceOf(CryptoError);
    const tamperedNonce = Buffer.from(sealed.nonce);
    tamperedNonce[0] ^= 0x01;
    await expect(cipher.open({ ...sealed, nonce: tamperedNonce })).rejects.toBeInstanceOf(CryptoError);
  });

  it('fails with DECRYPTION_FAILED under a different key', async () => {
    const sealed = await adapterFor(ringV1()).cipher.seal(encoder.encode(PLAINTEXT));
    const other = new CryptoServiceSecretCipher(
      new CryptoService(new KeyRing([{ version: 1, key: fixtureKey('different') }], 1)),
    );
    let caught: unknown;
    try {
      await other.open(sealed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('DECRYPTION_FAILED');
  });

  it('fails with KEY_VERSION_UNKNOWN when the ring lacks the recorded version', async () => {
    const sealed = await adapterFor(ringV1()).cipher.seal(encoder.encode(PLAINTEXT));
    const v2Only = new CryptoServiceSecretCipher(
      new CryptoService(new KeyRing([{ version: 2, key: fixtureKey('two') }], 2)),
    );
    let caught: unknown;
    try {
      await v2Only.open(sealed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('KEY_VERSION_UNKNOWN');
  });

  it('fails with ENVELOPE_MALFORMED on empty, short, or non-object input', async () => {
    const { cipher } = adapterFor(ringV1());
    const sealed = await cipher.seal(encoder.encode(PLAINTEXT));
    for (const bad of [
      null,
      undefined,
      { ...sealed, ciphertext: Buffer.alloc(0) },
      { ...sealed, ciphertext: Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]) },
      { ...sealed, nonce: Buffer.alloc(8) },
    ]) {
      let caught: unknown;
      try {
        await cipher.open(bad as unknown as SealedSecretBytes);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CryptoError);
      expect((caught as CryptoError).code).toBe('ENVELOPE_MALFORMED');
    }
  });

  it('fails with ENVELOPE_UNSUPPORTED_VERSION on a tampered version byte', async () => {
    const { cipher } = adapterFor(ringV1());
    const sealed = await cipher.seal(encoder.encode(PLAINTEXT));
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = 0x02;
    let caught: unknown;
    try {
      await cipher.open({ ...sealed, ciphertext: tampered });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('ENVELOPE_UNSUPPORTED_VERSION');
  });
});

describe('seam shape and factories', () => {
  it('is assignable to the V3-10a SecretCipher mirror shape', async () => {
    const cipher: MirrorSecretCipher = new CryptoServiceSecretCipher(new CryptoService(ringV1()));
    expect(cipher.keyVersion).toBe(1);
    const sealed = await cipher.seal(encoder.encode(PLAINTEXT));
    expect(decoder.decode(await cipher.open(sealed))).toBe(PLAINTEXT);
  });

  it('reports the current key version from a rotated ring', async () => {
    const ring = new KeyRing(
      [
        { version: 2, key: fixtureKey('two') },
        { version: 1, key: fixtureKey('one') },
      ],
      2,
    );
    const { cipher } = adapterFor(ring);
    expect(cipher.keyVersion).toBe(2);
    const sealed = await cipher.seal(encoder.encode(PLAINTEXT));
    expect(sealed.keyVersion).toBe(2);
  });

  it('builds from the environment and fails explicitly without a key', async () => {
    const cipher = createSecretCipherFromEnv({ ENCRYPTION_KEY: fixtureKey('env').toString('base64') });
    const sealed = await cipher.seal(encoder.encode(PLAINTEXT));
    expect(decoder.decode(await cipher.open(sealed))).toBe(PLAINTEXT);
    expect(() => createSecretCipherFromEnv({})).toThrowError(CryptoError);
  });

  it('is reachable through the rencana-named crypto.js barrel', () => {
    const service = createCryptoServiceFromEnv({ ENCRYPTION_KEY: fixtureKey('barrel').toString('hex') });
    expect(service.decryptToString(service.encrypt(PLAINTEXT))).toBe(PLAINTEXT);
  });
});

describe('no secret material in adapter errors', () => {
  it('never embeds plaintext or key text in thrown error messages', async () => {
    const keyText = fixtureKey('one').toString('base64');
    const { cipher } = adapterFor(ringV1());
    const sealed = await cipher.seal(encoder.encode(PLAINTEXT));
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[5] ^= 0xff;
    let caught: unknown;
    try {
      await cipher.open({ ...sealed, ciphertext: tampered });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).message).not.toContain(PLAINTEXT);
    expect((caught as CryptoError).message).not.toContain(keyText);
    expect((caught as CryptoError).message).not.toContain('fixture');
  });
});
