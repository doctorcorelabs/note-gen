// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Canonical entry point for server configuration. New code imports from
// './config/index.js' (or '../config/index.js'). The sibling config.ts
// file is a backward-compatibility shim for Fase 0 imports and re-exports
// everything defined here.

export * from './env.js';
