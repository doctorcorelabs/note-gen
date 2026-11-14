// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Backward-compatibility shim for Fase 0 imports. The configuration
// implementation lives in ./config/env.ts and is re-exported through
// ./config/index.ts. New code should import from the config directory;
// this file exists so existing imports of './config.js' keep working
// unchanged.

export * from './config/index.js';
