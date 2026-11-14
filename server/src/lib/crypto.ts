// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Re-export barrel at the path named by the wave 3 plan
// (rencana-gelombang3.md, V3-10 file list: server/src/lib/crypto.ts).
// The implementation lives in server/src/lib/crypto/; this file only
// re-exports its public surface, so consumers may import from either
// '../lib/crypto.js' or '../lib/crypto/index.js' with the same result.

export * from './crypto/index.js';
