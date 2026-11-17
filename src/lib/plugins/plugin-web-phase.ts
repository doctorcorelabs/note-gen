// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Single build-static source of truth for the plugin phase of the web fork.
 *
 * Design F8 section 10.5 names one flag, plugins.webPhase, with values
 * off/p1/p2/p3, read by the host at startup. Before wave 4 no such flag
 * existed in code: the web-chrome plugins flag was declarative with no
 * enforcement consumer, and OFF held only as a composition of separate
 * layers (gated settings page, empty installed list, invoke rejections).
 * This constant is the one value every enforcement site reads (W4-SEC).
 *
 * This module has zero imports on purpose. It must stay importable from
 * any layer, including UI flag registries and platform code, without
 * creating an import cycle. Do not add imports here.
 *
 * Changing this value is a reviewed code change made together with its
 * backend gate, never a runtime toggle. The emergency kill without a
 * redeploy required by F8 section 10.5 (a runtime layer) is NOT
 * implemented here; it remains open work (H4-KILL Q1). The value below
 * is the build ceiling: the MVP build is always OFF whatever any future
 * runtime layer says.
 */

export type PluginWebPhase = 'off' | 'p1' | 'p2' | 'p3'

export const PLUGIN_WEB_PHASE: PluginWebPhase = 'off'
