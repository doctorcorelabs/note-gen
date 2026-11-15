// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// TEST ONLY. Fake SecretCipher: a reversible encoding, NOT encryption.
// It exists to prove the seam plumbing (services store only the bytes
// the cipher returns, never plaintext; rotation changes keyVersion)
// without duplicating the V3-10b envelope implementation. The sealed
// form is base64, so a plaintext marker never appears as a substring
// of the stored bytes. Must never be used outside tests.

import type { SealedSecret, SecretCipher } from '../../src/services/settings/crypto-seam.js';

export class FakeSecretCipher implements SecretCipher {
  keyVersion = 1;

  async seal(plaintext: Uint8Array): Promise<SealedSecret> {
    const body = Buffer.from(plaintext).toString('base64');
    return {
      ciphertext: Buffer.from(`FAKE-SEAL-v${this.keyVersion}:${body}`, 'utf8'),
      keyVersion: this.keyVersion,
      nonce: Buffer.from(`fake-nonce-${this.keyVersion}`, 'utf8'),
    };
  }

  async open(sealed: SealedSecret): Promise<Uint8Array> {
    const text = sealed.ciphertext.toString('utf8');
    const prefix = `FAKE-SEAL-v${sealed.keyVersion}:`;
    if (!text.startsWith(prefix)) {
      throw new Error('Fake seal does not match its key version.');
    }
    return Buffer.from(text.slice(prefix.length), 'base64');
  }
}
