// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Explicit disabled-editor-surface flags for the web MVP (Fase 1,
// V3-24). Source of truth for which editor features are off in a
// browser: fase1/audit-editor-web.md section 4, under AD-20 (a
// disabled feature must say so in the UI, never fail silently) and
// the coordinator decision of 22:38 WIB 14 Nov 2026 that canvas is
// NOT active in the MVP. The plugin-OFF drafts were not waited for:
// the binding decisions (kill-switch OFF, terminal.open removed)
// are already in force and are enforced elsewhere; this module
// covers editor surfaces only.
//
// Rules for consumers:
// - Gate on isEditorFeatureDisabled, never on a local copy of the
//   list. The list lives here so a later phase enables a feature in
//   exactly one place, with its activation criteria from the audit.
// - Do not delete the gated code. Extensions and runtime modules
//   stay registered; only their triggers are closed (audit
//   section 4: "Tetap terdaftar").
// - Every gated surface must render a marker from the message
//   catalog (namespace editor.disabled.*). Silent hiding is
//   forbidden. The one exception is staticAssetSync, which has no
//   UI surface of its own in the audit (section 4.5): uploads just
//   save locally, and the flag only documents that no sync enqueue
//   may run before a web sync runtime exists.
// - Desktop (Tauri) behavior is unchanged: every flag below is off
//   only in web mode.

import { getPlatformMode, type PlatformMode } from "@/lib/platform/detect";

/** Catalog namespace for the disabled-surface copy (en + zh). */
export const EDITOR_DISABLED_CATALOG_NAMESPACE = "editor.disabled";

/**
 * Editor features that are explicitly disabled in the web MVP.
 * The segment names match the editor.disabled.* catalog keys,
 * except staticAssetSync, which has no catalog copy because it
 * has no UI surface (see the module header).
 */
export type EditorDisabledFeature =
  | "collaboration"
  | "ai"
  | "wiki"
  | "canvas"
  | "fileHistory"
  | "syncTools"
  | "imageHosting"
  | "editorWindow"
  | "printWindow"
  | "quickRecordWindow"
  | "screenshot"
  | "globalShortcuts"
  | "staticAssetSync";

/** Features with catalog copy and therefore with a UI marker. */
export type SurfacedEditorDisabledFeature = Exclude<
  EditorDisabledFeature,
  "staticAssetSync"
>;

export interface EditorDisabledFeatureInfo {
  /** Phase or decision that could activate the feature, per the audit. */
  readonly target: string;
  /** Catalog segment under editor.disabled, or null when there is no surface. */
  readonly catalogSegment: string | null;
}

export const EDITOR_DISABLED_FEATURES: Readonly<
  Record<EditorDisabledFeature, EditorDisabledFeatureInfo>
> = {
  collaboration: { target: "Fase 4, new architecture decision", catalogSegment: "collaboration" },
  ai: { target: "Fase 3, web AI transport", catalogSegment: "ai" },
  wiki: { target: "Fase 3, file plus database plus AI shims", catalogSegment: "wiki" },
  canvas: { target: "Post-MVP, coordinator decision required", catalogSegment: "canvas" },
  fileHistory: { target: "Post-MVP, sync backend", catalogSegment: "fileHistory" },
  syncTools: { target: "Post-MVP, sync backend", catalogSegment: "syncTools" },
  imageHosting: { target: "Post-MVP, hosting proxy", catalogSegment: "imageHosting" },
  editorWindow: { target: "Never as a Tauri window; browser tab instead", catalogSegment: "editorWindow" },
  printWindow: { target: "Never as a Tauri window; browser print dialog instead", catalogSegment: "printWindow" },
  quickRecordWindow: { target: "Never as a Tauri window; record form in main window instead", catalogSegment: "quickRecordWindow" },
  screenshot: { target: "Never in a browser; OS screenshot tool instead", catalogSegment: "screenshot" },
  globalShortcuts: { target: "Never in a browser; in-app shortcuts only", catalogSegment: "globalShortcuts" },
  staticAssetSync: { target: "Post-MVP, web sync runtime", catalogSegment: null },
};

export const ALL_EDITOR_DISABLED_FEATURES: readonly EditorDisabledFeature[] =
  Object.keys(EDITOR_DISABLED_FEATURES) as EditorDisabledFeature[];

/**
 * True when the feature is disabled in the given platform mode.
 * Every listed feature is disabled in web mode and available in
 * Tauri mode; an unlisted feature is never disabled by this module.
 */
export function isEditorFeatureDisabledInMode(
  feature: EditorDisabledFeature,
  mode: PlatformMode,
): boolean {
  return mode === "web" && feature in EDITOR_DISABLED_FEATURES;
}

/** True when the feature is disabled in the current runtime. */
export function isEditorFeatureDisabled(feature: EditorDisabledFeature): boolean {
  return isEditorFeatureDisabledInMode(feature, getPlatformMode());
}

/**
 * Catalog keys for the honest marker of a surfaced feature,
 * relative to the editor.disabled namespace, for use with
 * useTranslations('editor.disabled').
 */
export function editorDisabledMessageKeys(feature: SurfacedEditorDisabledFeature): {
  titleKey: string;
  messageKey: string;
} {
  const segment = EDITOR_DISABLED_FEATURES[feature].catalogSegment;
  if (segment === null) {
    throw new Error(`Editor feature has no disabled-surface copy: ${feature}`);
  }
  return { titleKey: `${segment}.title`, messageKey: `${segment}.message` };
}

/**
 * The 9 editor shortcuts in the `ai` group of
 * src/config/editor-shortcuts.ts (audit section 5.2, ids 27-35).
 * None of them may run an AI action in the web MVP; pressing one
 * while the editor is focused must show the AI disabled marker
 * instead of acting silently.
 */
export const AI_EDITOR_SHORTCUT_IDS = [
  "openAiMenu",
  "aiContinue",
  "aiPolish",
  "aiConcise",
  "aiExpand",
  "aiTranslate",
  "acceptAiSuggestion",
  "rejectAiSuggestion",
  "abortAiGeneration",
] as const;

export type AiEditorShortcutId = (typeof AI_EDITOR_SHORTCUT_IDS)[number];

export function isAiEditorShortcutId(value: string): value is AiEditorShortcutId {
  return (AI_EDITOR_SHORTCUT_IDS as readonly string[]).includes(value);
}
