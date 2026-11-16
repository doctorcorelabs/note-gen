// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

"use client"

// Asset list in record context (Fase 1, V3-32). This is the
// record-context list from the 3DP5 preparation map, not a global
// asset management page and not a new route: the owning surface
// (record detail or list) renders it with the items it owns and
// supplies the removal callback.
//
// Lane: every item is a record asset, resolved only through the
// record resolver (resolveRecordAssetDisplayUrl /
// recordAssetServeUrl). Workspace media paths are never passed
// here; the media lane keeps its own resolver and is untouched.
//
// Previews render only for previewable raster images
// (isPreviewableAssetImage). Anything else renders as a file row
// with its name and size, never as inline markup-capable
// content. A key the resolver rejects renders as a file row
// without preview or open link, so one bad key never breaks the
// whole list.
//
// Removal means reference removal (3DP5-Q1, Opsi A, pending a
// coordinator decision): the dialog confirms, the owning surface
// removes the reference, and the stored file stays on the
// server as an orphan. A failed removal stays visible: the
// dialog stays open with the failure, and after it closes the
// list keeps a failure note until the next removal starts or
// succeeds. No DELETE endpoint is called, because none exists.

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  buildAssetReferenceRemovalPlan,
  formatAssetBytes,
  isPreviewableAssetImage,
  recordAssetServeUrl,
  resolveRecordAssetDisplayUrl,
  type AssetReferenceRemovalPlan,
  type AssetReferenceRemovalResult,
  type RecordAssetListItem,
} from "@/lib/web/record-assets";

import { ASSET_LIST_COPY, assetPreviewAlt } from "./asset-copy";
import { AssetDeleteDialog } from "./asset-delete-dialog";

export interface RecordAssetListProps {
  items: readonly RecordAssetListItem[];
  // Removes the reference from the owning content or record.
  // Supplied by the owning surface; this list never invents a
  // removal request of its own.
  removeReference: (item: RecordAssetListItem) => Promise<unknown>;
  // Fires for both removal outcomes, after the dialog reports.
  // The parent refreshes its items on success.
  onRemovalResult?: (item: RecordAssetListItem, result: AssetReferenceRemovalResult) => void;
  disabled?: boolean;
}

interface PendingRemoval {
  item: RecordAssetListItem;
  plan: AssetReferenceRemovalPlan;
}

function displayUrlFor(item: RecordAssetListItem): string | null {
  try {
    return resolveRecordAssetDisplayUrl(item.assetKey, item.thumbnailUrl);
  } catch {
    return null;
  }
}

function openUrlFor(item: RecordAssetListItem): string | null {
  try {
    return recordAssetServeUrl(item.assetKey);
  } catch {
    return null;
  }
}

export function RecordAssetList({
  items,
  removeReference,
  onRemovalResult,
  disabled = false,
}: RecordAssetListProps) {
  const [pending, setPending] = useState<PendingRemoval | null>(null);
  const [failedRemoval, setFailedRemoval] = useState<{ fileName: string; message: string } | null>(null);

  function handleRemoveClick(item: RecordAssetListItem) {
    setFailedRemoval(null);
    setPending({ item, plan: buildAssetReferenceRemovalPlan(item) });
  }

  function handleDialogResult(result: AssetReferenceRemovalResult) {
    if (pending === null) {
      return;
    }
    onRemovalResult?.(pending.item, result);
    if (result.ok) {
      setFailedRemoval(null);
      setPending(null);
      return;
    }
    // The dialog stays open with the failure message. Keep a
    // list-level note too, so the failure stays visible if the
    // user cancels the dialog afterwards.
    setFailedRemoval({ fileName: pending.item.fileName, message: result.errorMessage });
  }

  return (
    <div className="space-y-3">
      <h2>{ASSET_LIST_COPY.heading}</h2>
      {items.length === 0 && <p>{ASSET_LIST_COPY.empty}</p>}
      {failedRemoval !== null && (
        <p role="alert" className="text-destructive">
          {ASSET_LIST_COPY.removalFailed}: {failedRemoval.fileName}. {failedRemoval.message}{" "}
          {ASSET_LIST_COPY.referenceKept}
        </p>
      )}
      <ul className="space-y-3">
        {items.map((item, index) => {
          const displayUrl = displayUrlFor(item);
          const openUrl = openUrlFor(item);
          const showPreview = isPreviewableAssetImage(item.mimeType) && displayUrl !== null;
          return (
            <li key={`${item.assetKey}:${index}`} className="space-y-1">
              {showPreview && displayUrl !== null ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayUrl} alt={assetPreviewAlt(item.fileName)} />
              ) : (
                <p>{ASSET_LIST_COPY.previewUnavailable}</p>
              )}
              <p>
                {item.fileName} ({formatAssetBytes(item.sizeBytes)})
              </p>
              {openUrl !== null && (
                <a href={openUrl} target="_blank" rel="noreferrer">
                  {ASSET_LIST_COPY.open}
                </a>
              )}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => handleRemoveClick(item)}
                >
                  {ASSET_LIST_COPY.removeReference}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <AssetDeleteDialog
        plan={pending?.plan ?? null}
        onCancel={() => setPending(null)}
        onResult={handleDialogResult}
        removeReference={() =>
          pending === null ? Promise.resolve() : removeReference(pending.item)
        }
      />
    </div>
  );
}
