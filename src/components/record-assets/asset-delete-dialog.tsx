// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

"use client"

// Confirmation dialog for removing an asset reference (Fase 1,
// V3-32). The dialog renders the removal plan honestly: it names
// what is removed (the reference, from one owner), what stays
// (the stored file, which no Fase 1 endpoint can delete), and
// which other references are known, absent, or unchecked. The
// stored file is never described as deleted.
//
// Behavior: confirming runs the removal through
// executeAssetReferenceRemoval. While removal runs, both buttons
// are disabled and the dialog cannot be dismissed. On failure
// the dialog stays open with the failure message, so the user
// sees that the reference is still there. On success the parent
// is notified and closes the dialog by clearing the plan.

import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  executeAssetReferenceRemoval,
  type AssetReferenceRemovalPlan,
  type AssetReferenceRemovalResult,
} from "@/lib/web/record-assets";

import { ASSET_DELETE_COPY, assetDeleteIntro } from "./asset-copy";

export interface AssetDeleteDialogProps {
  plan: AssetReferenceRemovalPlan | null;
  onCancel: () => void;
  // Fires for both outcomes. The parent clears the plan (closing
  // the dialog) only when result.ok is true; on failure the
  // dialog stays open with the failure message.
  onResult: (result: AssetReferenceRemovalResult) => void;
  removeReference: () => Promise<unknown>;
}

export function AssetDeleteDialog({
  plan,
  onCancel,
  onResult,
  removeReference,
}: AssetDeleteDialogProps) {
  const [isRemoving, setIsRemoving] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);

  async function handleConfirm() {
    if (plan === null || isRemoving) {
      return;
    }
    setIsRemoving(true);
    setFailureMessage(null);
    const result = await executeAssetReferenceRemoval(plan, removeReference);
    setIsRemoving(false);
    if (result.ok) {
      onResult(result);
      return;
    }
    setFailureMessage(result.errorMessage);
    onResult(result);
  }

  function handleOpenChange(open: boolean) {
    if (!open && !isRemoving) {
      setFailureMessage(null);
      onCancel();
    }
  }

  return (
    <AlertDialog open={plan !== null} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{ASSET_DELETE_COPY.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {plan !== null && (
                <p>{assetDeleteIntro(plan.fileName, plan.ownerLabel)}</p>
              )}
              <p>{ASSET_DELETE_COPY.orphanNotice}</p>
              {plan !== null && plan.knownReferences.length > 0 && (
                <div>
                  <p>{ASSET_DELETE_COPY.otherReferencesHeading}</p>
                  <ul className="list-disc space-y-1 pl-5">
                    {plan.knownReferences.map((reference) => (
                      <li key={reference.label}>
                        {reference.label}
                        {reference.detail !== undefined && reference.detail !== ""
                          ? ` (${reference.detail})`
                          : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {plan !== null &&
                plan.knownReferences.length === 0 &&
                plan.referencesChecked && <p>{ASSET_DELETE_COPY.noOtherReferences}</p>}
              {plan !== null && !plan.referencesChecked && (
                <p>{ASSET_DELETE_COPY.referencesNotChecked}</p>
              )}
              {failureMessage !== null && (
                <p role="alert" className="text-destructive">
                  {ASSET_DELETE_COPY.removalFailedHeading} {failureMessage}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRemoving}>
            {ASSET_DELETE_COPY.cancel}
          </AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={plan === null || isRemoving}
            onClick={() => void handleConfirm()}
          >
            {isRemoving ? ASSET_DELETE_COPY.removing : ASSET_DELETE_COPY.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
