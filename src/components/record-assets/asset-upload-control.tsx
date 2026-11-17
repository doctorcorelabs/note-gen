// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

"use client"

// Upload control for record assets (Fase 1, V3-32). One file per
// upload: one request uploads one file (desain-record-search.md
// section 4.1), so the input takes a single file and each
// selection is one POST /api/assets through uploadRecordAsset.
//
// The parent stores the returned assetKey as the record `url`
// (desain section 3.1: `url` for an asset-based record holds the
// opaque key, not an openable URL). No absolute server URL is
// ever stored in content; the key is the relative reference and
// the display URL is built only at render time by
// recordAssetServeUrl. This component never writes a record
// itself; the owning surface supplies onUploaded and decides
// what the key attaches to.
//
// Failures are shown in place with the message from
// describeAssetUploadError and the file is reported as not
// uploaded. Nothing fails silently: a failed upload leaves no
// row, no key, and no stored reference behind.

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  describeAssetUploadError,
  uploadRecordAsset,
  type AssetRepresentation,
  type RecordAssetApiClient,
} from "@/lib/web/record-assets";

import { ASSET_UPLOAD_COPY } from "./asset-copy";

export interface AssetUploadControlProps {
  // Fires once per successful upload with the server
  // representation. The parent stores asset.assetKey.
  onUploaded: (asset: AssetRepresentation) => void;
  // Client to send through. Defaults to defaultApiClient inside
  // uploadRecordAsset. The wiring layer passes a client with a
  // CSRF token provider.
  client?: RecordAssetApiClient;
  disabled?: boolean;
}

export function AssetUploadControl({ onUploaded, client, disabled = false }: AssetUploadControlProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);

  const isDisabled = disabled || isUploading;

  async function handleFileSelected(file: File | undefined) {
    if (file === undefined || isUploading) {
      return;
    }
    setIsUploading(true);
    setFailureMessage(null);
    setUploadedFileName(null);
    try {
      const asset = await uploadRecordAsset(file, client === undefined ? {} : { client });
      setUploadedFileName(asset.fileName);
      onUploaded(asset);
    } catch (error) {
      setFailureMessage(describeAssetUploadError(error));
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        disabled={isDisabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so selecting the same file again after a
          // failure fires onChange and retries the upload.
          event.target.value = "";
          void handleFileSelected(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={isDisabled}
        onClick={() => inputRef.current?.click()}
      >
        {isUploading ? ASSET_UPLOAD_COPY.uploading : ASSET_UPLOAD_COPY.chooseFile}
      </Button>
      <p className="text-sm text-muted-foreground">{ASSET_UPLOAD_COPY.hint}</p>
      {uploadedFileName !== null && (
        <p role="status">
          {ASSET_UPLOAD_COPY.uploaded}: {uploadedFileName}
        </p>
      )}
      {failureMessage !== null && (
        <p role="alert" className="text-destructive">
          {ASSET_UPLOAD_COPY.uploadFailed}. {failureMessage}
        </p>
      )}
    </div>
  );
}
