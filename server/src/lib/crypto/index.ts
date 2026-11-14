// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Public surface of the server-side envelope encryption module.
// Consumers: the secrets routes (V3-10a) and, later, the TOTP sealing
// path (V3-11 onwards) and any other server code that must store a
// secret at rest. Nothing in this module is importable from the
// browser bundle: it depends on node:crypto and on environment keys.

export {
  CryptoError,
  type CryptoErrorCode,
} from './errors.js';
export {
  DEFAULT_KEY_VERSION,
  ENCRYPTION_KEY_BYTES,
  KeyRing,
  decodeEncryptionKey,
  loadKeyRingFromEnv,
  type KeyRingEntry,
  type KeyRingEnv,
} from './key-ring.js';
export {
  CryptoService,
  ENVELOPE_FORMAT_VERSION,
  ENVELOPE_STRING_PREFIX,
  createCryptoService,
  createCryptoServiceFromEnv,
  inspectSealedString,
  type SealOptions,
  type SealedParts,
  type SealedStringHeader,
} from './envelope.js';
