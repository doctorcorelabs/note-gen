// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Public surface of the web invoke router. Callers go through the
 * platform registry and these interfaces; they never import Tauri
 * packages and never build command names or endpoint paths by hand.
 */

export * from "./handlers";
export * from "./interface";
export * from "./rejections";
export * from "./routes";
export * from "./stubs";
export * from "./web";
