// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// English UI copy for the record asset components (Fase 1, V3-32).
//
// The copy lives here, in one module, instead of the message
// catalog. Reason: a new catalog namespace needs integrator
// approval (registry D-7), and the sweep batches own catalog
// union during wave 3D; adding keys from this branch would risk
// a union collision with parallel UI workers. The strings are
// English, matching the locale default (desain-record-search.md
// section 7.4) and the standing UI language decision. A later
// catalog migration maps each export below to one key; the
// proposed key names are listed in the V3-32 handover report.
// No string in this module is ever built by concatenation with
// user data except through the small formatter functions, which
// keep the sentence shape fixed.

export const ASSET_UPLOAD_COPY = {
  chooseFile: "Choose file",
  uploading: "Uploading...",
  hint: "One file per upload. The server checks the file contents, not just its name.",
  uploaded: "Uploaded",
  uploadFailed: "Upload failed",
} as const;

export const ASSET_LIST_COPY = {
  heading: "Assets",
  empty: "No assets yet.",
  removeReference: "Remove reference",
  open: "Open",
  previewUnavailable: "Preview unavailable.",
  removalFailed: "Removal failed",
  referenceKept: "The reference is still there.",
} as const;

export const ASSET_DELETE_COPY = {
  title: "Remove this reference?",
  cancel: "Cancel",
  confirm: "Remove reference",
  removing: "Removing...",
  orphanNotice:
    "The stored file is not deleted by this action. It stays on the server as an orphan. Orphan cleanup is planned for a later phase and will not delete files that are still referenced.",
  noOtherReferences: "No other references were found.",
  referencesNotChecked:
    "Other references were not checked. Any other content that references this file will keep pointing at it.",
  otherReferencesHeading: "Other known references that will keep pointing at this file:",
  removalFailedHeading: "Removal failed. The reference was not removed.",
} as const;

export function assetDeleteIntro(fileName: string, ownerLabel: string): string {
  return `This removes the reference to "${fileName}" from ${ownerLabel}.`;
}

export function assetPreviewAlt(fileName: string): string {
  return `Asset preview: ${fileName}`;
}

export function assetReferenceLabel(assetKey: string): string {
  return `Reference: ${assetKey}`;
}
