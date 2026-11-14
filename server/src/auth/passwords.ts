// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Password hashing with Argon2id (desain-auth.md section 1.8).
// Library choice: the npm `argon2` package (MIT), version 0.45.2.
// Justification (recorded in laporan-v3-01b-auth.md): native bindings
// to the reference libargon2 C implementation, PHC string encoding
// built in, explicit Argon2id parameters, and a built-in
// needsRehash check, which makes opportunistic re-hashing on login a
// one-line decision. It is the same family of implementation the
// upstream reference server used (argon2.hash with type argon2id),
// but this code sets the OWASP-derived parameters explicitly instead
// of relying on library defaults. A pure-WASM alternative
// (hash-wasm) was considered and set aside because the native build
// succeeds in this environment and the reference implementation is
// the best-audited one. Parameters are the OWASP cheat-sheet values
// recorded in desain-auth.md (memory 19456 KiB, time 2, parallelism
// 1, output 32 bytes); the guide version checked at implementation
// time is recorded in the worker report.

import argon2 from 'argon2';
import {
  ARGON2_HASH_LENGTH,
  ARGON2_MEMORY_COST_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './values.js';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  // Returns false for a wrong password AND for a malformed stored
  // hash; callers must never distinguish the two to the client.
  verify(storedHash: string, password: string): Promise<boolean>;
  needsRehash(storedHash: string): boolean;
}

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: ARGON2_MEMORY_COST_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
  hashLength: ARGON2_HASH_LENGTH,
} as const;

export class Argon2PasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, { ...ARGON2_OPTIONS });
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(storedHash, password);
    } catch {
      return false;
    }
  }

  needsRehash(storedHash: string): boolean {
    try {
      return argon2.needsRehash(storedHash, { ...ARGON2_OPTIONS });
    } catch {
      // An unparsable stored hash can never verify, so re-hash
      // detection is moot; report false and let verify fail closed.
      return false;
    }
  }
}

// Shape check only (desain-auth.md section 1.8): 12-128 characters,
// counted in code points. No rigid complexity rules. Returns a
// machine-readable issue string, or null when the shape is valid.
export function passwordShapeIssue(password: unknown): string | null {
  if (typeof password !== 'string') {
    return 'password must be a string';
  }
  if (password.includes('\0')) {
    return 'password must not contain NUL';
  }
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) {
    return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return `password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}
