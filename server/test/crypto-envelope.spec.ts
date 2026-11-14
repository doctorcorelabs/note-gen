// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the envelope encryption module (V3-10b). All key material
// below is derived from clearly marked TEST-ONLY fixture strings; no
// real key is used anywhere in this file.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CryptoError,
  CryptoService,
  ENVELOPE_STRING_PREFIX,
  KeyRing,
  createCryptoServiceFromEnv,
  decodeEncryptionKey,
  inspectSealedString,
  loadKeyRingFromEnv,
} from '../src/lib/crypto/index.js';

function fixtureKey(marker: string): Buffer {
  return createHash('sha256').update(`v3-10b TEST-ONLY fixture key: ${marker}`).digest();
}

function ringV1(): KeyRing {
  return new KeyRing([{ version: 1, key: fixtureKey('one') }], 1);
}

function ringV2WithV1Previous(): KeyRing {
  return new KeyRing(
    [
      { version: 2, key: fixtureKey('two') },
      { version: 1, key: fixtureKey('one') },
    ],
    2,
  );
}

const PLAINTEXT = 'test-only secret value 7f3a9c';
const OTHER_PLAINTEXT = 'another test-only value';

describe('round-trip', () => {
  it('encrypts and decrypts text through the parts form', () => {
    const service = new CryptoService(ringV1());
    const parts = service.encrypt(PLAINTEXT);
    expect(parts.formatVersion).toBe(1);
    expect(parts.keyVersion).toBe(1);
    expect(parts.nonce.length).toBe(12);
    expect(parts.ciphertext[0]).toBe(0x01);
    expect(service.decryptToString(parts)).toBe(PLAINTEXT);
  });

  it('encrypts and decrypts buffers', () => {
    const service = new CryptoService(ringV1());
    const input = Buffer.from([0, 1, 2, 250, 255]);
    expect(service.decrypt(service.encrypt(input))).toEqual(input);
  });

  it('encrypts and decrypts empty plaintext', () => {
    const service = new CryptoService(ringV1());
    expect(service.decryptToString(service.encrypt(''))).toBe('');
  });

  it('round-trips through the string form', () => {
    const service = new CryptoService(ringV1());
    const sealed = service.seal(PLAINTEXT);
    expect(sealed.startsWith(ENVELOPE_STRING_PREFIX)).toBe(true);
    expect(service.openToString(sealed)).toBe(PLAINTEXT);
    expect(inspectSealedString(sealed)).toEqual({ formatVersion: 1, keyVersion: 1 });
  });

  it('uses a fresh nonce per seal, so identical plaintext seals differently', () => {
    const service = new CryptoService(ringV1());
    const first = service.encrypt(PLAINTEXT);
    const second = service.encrypt(PLAINTEXT);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(service.seal(PLAINTEXT)).not.toBe(service.seal(PLAINTEXT));
  });

  it('binds and requires caller additional authenticated data', () => {
    const service = new CryptoService(ringV1());
    const aad = 'secrets:ai_provider:provider-a';
    const parts = service.encrypt(PLAINTEXT, { aad });
    expect(service.decryptToString(parts, { aad })).toBe(PLAINTEXT);
    expect(() => service.decrypt(parts)).toThrowError(CryptoError);
    expect(() => service.decrypt(parts, { aad: 'secrets:ai_provider:other' })).toThrowError(CryptoError);
  });
});

describe('tamper detection', () => {
  it('rejects a flipped ciphertext byte', () => {
    const service = new CryptoService(ringV1());
    const parts = service.encrypt(PLAINTEXT);
    const tampered = Buffer.from(parts.ciphertext);
    tampered[5] ^= 0xff;
    let caught: unknown;
    try {
      service.decrypt({ ...parts, ciphertext: tampered });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('DECRYPTION_FAILED');
  });

  it('rejects a flipped authentication tag byte', () => {
    const service = new CryptoService(ringV1());
    const parts = service.encrypt(PLAINTEXT);
    const tampered = Buffer.from(parts.ciphertext);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => service.decrypt({ ...parts, ciphertext: tampered })).toThrowError(CryptoError);
  });

  it('rejects a flipped nonce byte', () => {
    const service = new CryptoService(ringV1());
    const parts = service.encrypt(PLAINTEXT);
    const tampered = Buffer.from(parts.nonce);
    tampered[0] ^= 0x01;
    expect(() => service.decrypt({ ...parts, nonce: tampered })).toThrowError(CryptoError);
  });

  it('rejects a tampered format version byte', () => {
    const service = new CryptoService(ringV1());
    const parts = service.encrypt(PLAINTEXT);
    const tampered = Buffer.from(parts.ciphertext);
    tampered[0] = 0x02;
    let caught: unknown;
    try {
      service.decrypt({ ...parts, ciphertext: tampered });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('ENVELOPE_UNSUPPORTED_VERSION');
  });

  it('rejects truncated and short sealed parts', () => {
    const service = new CryptoService(ringV1());
    const parts = service.encrypt(PLAINTEXT);
    expect(() => service.decrypt({ ...parts, ciphertext: Buffer.alloc(5) })).toThrowError(CryptoError);
    expect(() => service.decrypt({ ...parts, nonce: Buffer.alloc(8) })).toThrowError(CryptoError);
  });
});

describe('wrong key and unknown versions', () => {
  it('fails when opened with a different key', () => {
    const sealed = new CryptoService(ringV1()).encrypt(PLAINTEXT);
    const otherRing = new KeyRing([{ version: 1, key: fixtureKey('different') }], 1);
    let caught: unknown;
    try {
      new CryptoService(otherRing).decrypt(sealed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('DECRYPTION_FAILED');
  });

  it('fails explicitly when no key matches the recorded version', () => {
    const sealed = new CryptoService(ringV1()).encrypt(PLAINTEXT);
    const v2Only = new KeyRing([{ version: 2, key: fixtureKey('two') }], 2);
    let caught: unknown;
    try {
      new CryptoService(v2Only).decrypt(sealed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('KEY_VERSION_UNKNOWN');
  });

  it('rejects malformed string envelopes', () => {
    const service = new CryptoService(ringV1());
    expect(() => service.open('not-an-envelope')).toThrowError(CryptoError);
    expect(() => service.open(`${ENVELOPE_STRING_PREFIX}!!!`)).toThrowError(CryptoError);
    expect(() => service.open(`${ENVELOPE_STRING_PREFIX}AAAA`)).toThrowError(CryptoError);
    expect(() => service.open('')).toThrowError(CryptoError);
  });

  it('rejects a string envelope whose version byte is tampered', () => {
    const service = new CryptoService(ringV1());
    const sealed = service.seal(PLAINTEXT);
    const body = Buffer.from(sealed.slice(ENVELOPE_STRING_PREFIX.length), 'base64url');
    body[0] = 0x09;
    const tampered = ENVELOPE_STRING_PREFIX + body.toString('base64url');
    let caught: unknown;
    try {
      service.open(tampered);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('ENVELOPE_UNSUPPORTED_VERSION');
  });
});

describe('rotation', () => {
  it('opens data sealed under a retired key when the old key is retained', () => {
    const oldService = new CryptoService(ringV1());
    const parts = oldService.encrypt(PLAINTEXT);
    const sealed = oldService.seal(OTHER_PLAINTEXT);
    const rotated = new CryptoService(ringV2WithV1Previous());
    expect(rotated.decryptToString(parts)).toBe(PLAINTEXT);
    expect(rotated.openToString(sealed)).toBe(OTHER_PLAINTEXT);
    expect(rotated.needsRotation(parts)).toBe(true);
    expect(rotated.needsRotation(sealed)).toBe(true);
  });

  it('re-seals rotated data under the current key', () => {
    const oldService = new CryptoService(ringV1());
    const rotated = new CryptoService(ringV2WithV1Previous());
    const parts = rotated.rotateParts(oldService.encrypt(PLAINTEXT));
    expect(parts.keyVersion).toBe(2);
    const v2Only = new CryptoService(new KeyRing([{ version: 2, key: fixtureKey('two') }], 2));
    expect(v2Only.decryptToString(parts)).toBe(PLAINTEXT);
    const resealed = rotated.rotateString(oldService.seal(OTHER_PLAINTEXT));
    expect(inspectSealedString(resealed).keyVersion).toBe(2);
    expect(v2Only.openToString(resealed)).toBe(OTHER_PLAINTEXT);
  });

  it('leaves current-version data unchanged on rotation', () => {
    const service = new CryptoService(ringV2WithV1Previous());
    const parts = service.encrypt(PLAINTEXT);
    expect(service.needsRotation(parts)).toBe(false);
    expect(service.rotateParts(parts)).toBe(parts);
    const sealed = service.seal(PLAINTEXT);
    expect(service.rotateString(sealed)).toBe(sealed);
  });

  it('rotation preserves the caller AAD binding', () => {
    const aad = 'secrets:ai_provider:provider-a';
    const oldService = new CryptoService(ringV1());
    const rotated = new CryptoService(ringV2WithV1Previous());
    const parts = rotated.rotateParts(oldService.encrypt(PLAINTEXT, { aad }), { aad });
    expect(rotated.decryptToString(parts, { aad })).toBe(PLAINTEXT);
    expect(() => rotated.decrypt(parts)).toThrowError(CryptoError);
  });
});

describe('key loading from the environment', () => {
  it('fails explicitly when ENCRYPTION_KEY is missing', () => {
    let caught: unknown;
    try {
      loadKeyRingFromEnv({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('ENCRYPTION_KEY_MISSING');
  });

  it('fails explicitly when ENCRYPTION_KEY is blank', () => {
    expect(() => loadKeyRingFromEnv({ ENCRYPTION_KEY: '   ' })).toThrowError(CryptoError);
  });

  it('reads the legacy SECRETS_ENCRYPTION_KEY alias when the canonical name is absent', () => {
    const raw = fixtureKey('alias-only');
    const ring = loadKeyRingFromEnv({ SECRETS_ENCRYPTION_KEY: raw.toString('base64') });
    expect(ring.currentKey()).toEqual(raw);
    const service = createCryptoServiceFromEnv({ SECRETS_ENCRYPTION_KEY: raw.toString('hex') });
    expect(service.decryptToString(service.encrypt(PLAINTEXT))).toBe(PLAINTEXT);
  });

  it('accepts both key names when they decode to the same key', () => {
    const raw = fixtureKey('both-names-same');
    const ring = loadKeyRingFromEnv({
      ENCRYPTION_KEY: raw.toString('base64'),
      SECRETS_ENCRYPTION_KEY: raw.toString('hex'),
    });
    expect(ring.currentKey()).toEqual(raw);
  });

  it('fails closed when both key names decode to different keys', () => {
    let caught: unknown;
    try {
      loadKeyRingFromEnv({
        ENCRYPTION_KEY: fixtureKey('canonical').toString('base64'),
        SECRETS_ENCRYPTION_KEY: fixtureKey('legacy-different').toString('base64'),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('ENCRYPTION_KEY_INVALID');
  });

  it('accepts hex, base64, and base64url encodings of the same key', () => {
    const raw = fixtureKey('encodings');
    const hex = loadKeyRingFromEnv({ ENCRYPTION_KEY: raw.toString('hex') });
    const b64 = loadKeyRingFromEnv({ ENCRYPTION_KEY: raw.toString('base64') });
    const b64url = loadKeyRingFromEnv({ ENCRYPTION_KEY: raw.toString('base64url') });
    expect(hex.currentKey()).toEqual(raw);
    expect(b64.currentKey()).toEqual(raw);
    expect(b64url.currentKey()).toEqual(raw);
    const sealed = new CryptoService(hex).encrypt(PLAINTEXT);
    expect(new CryptoService(b64url).decryptToString(sealed)).toBe(PLAINTEXT);
  });

  it('rejects keys that are not exactly 32 bytes', () => {
    expect(() => decodeEncryptionKey(Buffer.alloc(31).toString('base64'))).toThrowError(CryptoError);
    expect(() => decodeEncryptionKey(Buffer.alloc(33).toString('hex'))).toThrowError(CryptoError);
    expect(() => decodeEncryptionKey('not a key at all')).toThrowError(CryptoError);
    expect(() => loadKeyRingFromEnv({ ENCRYPTION_KEY: 'short' })).toThrowError(CryptoError);
  });

  it('rejects invalid key versions and previous-key lists', () => {
    const key = fixtureKey('versions').toString('base64');
    expect(() => loadKeyRingFromEnv({ ENCRYPTION_KEY: key, ENCRYPTION_KEY_VERSION: '0' })).toThrowError(CryptoError);
    expect(() => loadKeyRingFromEnv({ ENCRYPTION_KEY: key, ENCRYPTION_KEY_VERSION: 'abc' })).toThrowError(CryptoError);
    expect(() => loadKeyRingFromEnv({ ENCRYPTION_KEY: key, ENCRYPTION_PREVIOUS_KEYS: 'no-equals-sign' })).toThrowError(CryptoError);
    expect(() => loadKeyRingFromEnv({ ENCRYPTION_KEY: key, ENCRYPTION_PREVIOUS_KEYS: ` =${key}` })).toThrowError(CryptoError);
    expect(() =>
      loadKeyRingFromEnv({ ENCRYPTION_KEY: key, ENCRYPTION_KEY_VERSION: '2', ENCRYPTION_PREVIOUS_KEYS: `2=${key}` }),
    ).toThrowError(CryptoError);
  });

  it('loads previous keys and opens older data through the env factory', () => {
    const oldKey = fixtureKey('one');
    const newKey = fixtureKey('two');
    const oldService = new CryptoService(ringV1());
    const sealed = oldService.encrypt(PLAINTEXT);
    const service = createCryptoServiceFromEnv({
      ENCRYPTION_KEY: newKey.toString('base64'),
      ENCRYPTION_KEY_VERSION: '2',
      ENCRYPTION_PREVIOUS_KEYS: `1=${oldKey.toString('base64')}`,
    });
    expect(service.currentKeyVersion).toBe(2);
    expect(service.decryptToString(sealed)).toBe(PLAINTEXT);
    expect(service.needsRotation(sealed)).toBe(true);
  });

  it('fails explicitly at factory time when the key is missing', () => {
    expect(() => createCryptoServiceFromEnv({})).toThrowError(CryptoError);
  });
});

describe('no secret material in outputs or errors', () => {
  it('never embeds plaintext in sealed output', () => {
    const service = new CryptoService(ringV1());
    const parts = service.encrypt(PLAINTEXT);
    expect(parts.ciphertext.toString('utf8')).not.toContain(PLAINTEXT);
    expect(parts.ciphertext.toString('base64')).not.toContain(Buffer.from(PLAINTEXT).toString('base64'));
    expect(service.seal(PLAINTEXT)).not.toContain(PLAINTEXT);
  });

  it('never embeds key or plaintext material in error messages', () => {
    const keyText = fixtureKey('one').toString('base64');
    const errors: CryptoError[] = [];
    try {
      loadKeyRingFromEnv({});
    } catch (error) {
      errors.push(error as CryptoError);
    }
    const service = new CryptoService(ringV1());
    const parts = service.encrypt(PLAINTEXT);
    const tampered = Buffer.from(parts.ciphertext);
    tampered[5] ^= 0xff;
    try {
      service.decrypt({ ...parts, ciphertext: tampered });
    } catch (error) {
      errors.push(error as CryptoError);
    }
    try {
      service.open('not-an-envelope');
    } catch (error) {
      errors.push(error as CryptoError);
    }
    expect(errors.length).toBe(3);
    for (const error of errors) {
      expect(error.message).not.toContain(PLAINTEXT);
      expect(error.message).not.toContain(keyText);
      expect(error.message).not.toContain('fixture');
    }
  });
});
