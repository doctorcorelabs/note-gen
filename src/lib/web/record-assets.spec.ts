// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Unit tests for src/lib/web/record-assets.ts (Fase 1, V3-32).
//
// Runner: Vitest, unit project (vitest run --project unit). The
// suite uses a fake ApiClient only; no test sends HTTP, touches
// the DOM, or touches storage. Upload tests inspect the captured
// FormData to pin the contract shape: one "file" part plus one
// "fileName" part, posted to /api/assets through requestJson.

import { describe, expect, it } from "vitest";

import type { ApiRequestOptions } from "./api-client";
import { ApiError } from "./errors";
import {
  assetLimitBytesFromError,
  buildAssetReferenceRemovalPlan,
  countAssetKeyMentions,
  describeAssetUploadError,
  executeAssetReferenceRemoval,
  formatAssetBytes,
  isPreviewableAssetImage,
  parseAssetRepresentation,
  recordAssetServeUrl,
  resolveRecordAssetDisplayUrl,
  textStillReferencesAsset,
  uploadRecordAsset,
  type RecordAssetListItem,
} from "./record-assets";

interface CapturedRequest {
  path: string;
  options: ApiRequestOptions;
}

function createRecordingClient(handler: (call: CapturedRequest) => unknown) {
  const calls: CapturedRequest[] = [];
  const client = {
    async requestJson<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
      const call = { path, options };
      calls.push(call);
      return handler(call) as T;
    },
  };
  return { calls, client };
}

const VALID_REPRESENTATION = {
  assetKey: "ast_0123456789abcdef0123456789abcdef",
  fileName: "photo.png",
  mimeType: "image/png",
  sizeBytes: 184320,
  contentHash: "sha256:9f2c1a9f2c1a9f2c1a9f2c1a9f2c1a9f2c1a9f2c1a9f2c1a9f2c1a9f2c1a",
  createdAt: 1794660000000,
};

function pngFile(name = "photo.png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, {
    type: "image/png",
  });
}

describe("parseAssetRepresentation", () => {
  it("accepts a complete valid representation", () => {
    expect(parseAssetRepresentation(VALID_REPRESENTATION)).toEqual(VALID_REPRESENTATION);
  });

  it("rejects null, arrays, and non-objects", () => {
    expect(parseAssetRepresentation(null)).toBeNull();
    expect(parseAssetRepresentation([])).toBeNull();
    expect(parseAssetRepresentation("photo.png")).toBeNull();
    expect(parseAssetRepresentation(undefined)).toBeNull();
  });

  it("rejects a missing or empty assetKey", () => {
    expect(parseAssetRepresentation({ ...VALID_REPRESENTATION, assetKey: "" })).toBeNull();
    expect(
      parseAssetRepresentation({
        fileName: VALID_REPRESENTATION.fileName,
        mimeType: VALID_REPRESENTATION.mimeType,
        sizeBytes: VALID_REPRESENTATION.sizeBytes,
        contentHash: VALID_REPRESENTATION.contentHash,
        createdAt: VALID_REPRESENTATION.createdAt,
      }),
    ).toBeNull();
  });

  it("rejects wrong types for sizeBytes and createdAt", () => {
    expect(parseAssetRepresentation({ ...VALID_REPRESENTATION, sizeBytes: "184320" })).toBeNull();
    expect(parseAssetRepresentation({ ...VALID_REPRESENTATION, sizeBytes: -1 })).toBeNull();
    expect(parseAssetRepresentation({ ...VALID_REPRESENTATION, sizeBytes: 1.5 })).toBeNull();
    expect(parseAssetRepresentation({ ...VALID_REPRESENTATION, createdAt: "1794660000000" })).toBeNull();
    expect(parseAssetRepresentation({ ...VALID_REPRESENTATION, createdAt: Number.NaN })).toBeNull();
  });

  it("rejects empty fileName, mimeType, and contentHash", () => {
    expect(parseAssetRepresentation({ ...VALID_REPRESENTATION, fileName: "" })).toBeNull();
    expect(parseAssetRepresentation({ ...VALID_REPRESENTATION, mimeType: "" })).toBeNull();
    expect(parseAssetRepresentation({ ...VALID_REPRESENTATION, contentHash: "" })).toBeNull();
  });
});

describe("uploadRecordAsset", () => {
  it("posts one file part plus one fileName part to /api/assets", async () => {
    const { calls, client } = createRecordingClient(() => VALID_REPRESENTATION);
    const result = await uploadRecordAsset(pngFile(), { client });
    expect(result).toEqual(VALID_REPRESENTATION);
    expect(calls).toHaveLength(1);
    const call = calls[0] as CapturedRequest;
    expect(call.path).toBe("/api/assets");
    expect(call.options.method).toBe("POST");
    const form = call.options.formDataBody as FormData;
    expect([...form.keys()]).toEqual(["file", "fileName"]);
    const filePart = form.get("file");
    expect(filePart).toBeInstanceOf(File);
    expect((filePart as File).name).toBe("photo.png");
    expect(form.get("fileName")).toBe("photo.png");
  });

  it("prefers the explicit fileName option over the File name", async () => {
    const { calls, client } = createRecordingClient(() => VALID_REPRESENTATION);
    await uploadRecordAsset(pngFile("camera-dump.bin"), { client, fileName: "photo.png" });
    const form = (calls[0] as CapturedRequest).options.formDataBody as FormData;
    expect((form.get("file") as File).name).toBe("photo.png");
    expect(form.get("fileName")).toBe("photo.png");
  });

  it("uploads a Blob when fileName is given", async () => {
    const { calls, client } = createRecordingClient(() => VALID_REPRESENTATION);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    await uploadRecordAsset(blob, { client, fileName: "photo.png" });
    expect(calls).toHaveLength(1);
    const form = (calls[0] as CapturedRequest).options.formDataBody as FormData;
    expect((form.get("file") as File).name).toBe("photo.png");
  });

  it("refuses a nameless Blob without sending a request", async () => {
    const { calls, client } = createRecordingClient(() => VALID_REPRESENTATION);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    await expect(uploadRecordAsset(blob, { client })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty file without sending a request", async () => {
    const { calls, client } = createRecordingClient(() => VALID_REPRESENTATION);
    const empty = new File([], "empty.png", { type: "image/png" });
    await expect(uploadRecordAsset(empty, { client })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed server response shape", async () => {
    const { client } = createRecordingClient(() => ({ assetKey: "ast_x" }));
    await expect(uploadRecordAsset(pngFile(), { client })).rejects.toMatchObject({
      localCode: "SERVER_ERROR",
    });
  });

  it("propagates the server ApiError unchanged", async () => {
    const serverError = new ApiError({
      localCode: "PAYLOAD_TOO_LARGE",
      wireCode: "asset_too_large",
      status: 413,
      retryable: false,
      requestId: "req-1",
      details: { limitBytes: 20971520 },
      wireMessage: "Asset too large.",
    });
    const { client } = createRecordingClient(() => {
      throw serverError;
    });
    await expect(uploadRecordAsset(pngFile(), { client })).rejects.toBe(serverError);
  });

  it("forwards the caller abort signal", async () => {
    const { calls, client } = createRecordingClient(() => VALID_REPRESENTATION);
    const controller = new AbortController();
    await uploadRecordAsset(pngFile(), { client, signal: controller.signal });
    expect((calls[0] as CapturedRequest).options.signal).toBe(controller.signal);
  });
});

describe("assetLimitBytesFromError", () => {
  it("reads limitBytes from an asset_too_large error", () => {
    const error = new ApiError({
      localCode: "PAYLOAD_TOO_LARGE",
      wireCode: "asset_too_large",
      status: 413,
      retryable: false,
      requestId: null,
      details: { limitBytes: 20971520 },
      wireMessage: null,
    });
    expect(assetLimitBytesFromError(error)).toBe(20971520);
  });

  it("returns null for other codes, bad limits, and non-ApiError values", () => {
    const otherCode = new ApiError({
      localCode: "SERVER_ERROR",
      wireCode: "unsupported_media_type",
      status: 415,
      retryable: false,
      requestId: null,
      details: { limitBytes: 20971520 },
      wireMessage: null,
    });
    expect(assetLimitBytesFromError(otherCode)).toBeNull();
    const badLimit = new ApiError({
      localCode: "PAYLOAD_TOO_LARGE",
      wireCode: "asset_too_large",
      status: 413,
      retryable: false,
      requestId: null,
      details: { limitBytes: "20971520" },
      wireMessage: null,
    });
    expect(assetLimitBytesFromError(badLimit)).toBeNull();
    expect(assetLimitBytesFromError(new Error("boom"))).toBeNull();
    expect(assetLimitBytesFromError(null)).toBeNull();
  });
});

describe("describeAssetUploadError", () => {
  it("shows the server limit when the error carries one", () => {
    const error = new ApiError({
      localCode: "PAYLOAD_TOO_LARGE",
      wireCode: "asset_too_large",
      status: 413,
      retryable: false,
      requestId: null,
      details: { limitBytes: 20971520 },
      wireMessage: null,
    });
    expect(describeAssetUploadError(error)).toContain("20 MB");
  });

  it("maps known wire codes to plain messages", () => {
    const unsupported = new ApiError({
      localCode: "SERVER_ERROR",
      wireCode: "unsupported_media_type",
      status: 415,
      retryable: false,
      requestId: null,
      details: {},
      wireMessage: null,
    });
    expect(describeAssetUploadError(unsupported)).toContain("not accepted");
    const expired = new ApiError({
      localCode: "AUTH_REQUIRED",
      wireCode: "unauthenticated",
      status: 401,
      retryable: false,
      requestId: null,
      details: {},
      wireMessage: null,
    });
    expect(describeAssetUploadError(expired)).toContain("session has expired");
  });

  it("falls back to a generic message for unknown failures", () => {
    expect(describeAssetUploadError(null)).toContain("Upload failed");
    expect(describeAssetUploadError(new Error("custom failure"))).toBe("custom failure");
  });
});

describe("formatAssetBytes", () => {
  it("formats bytes, KB, and MB", () => {
    expect(formatAssetBytes(0)).toBe("0 Bytes");
    expect(formatAssetBytes(512)).toBe("512 Bytes");
    expect(formatAssetBytes(1024)).toBe("1 KB");
    expect(formatAssetBytes(1536)).toBe("1.5 KB");
    expect(formatAssetBytes(20971520)).toBe("20 MB");
  });

  it("reports unknown size for invalid input", () => {
    expect(formatAssetBytes(-1)).toBe("Unknown size");
    expect(formatAssetBytes(Number.NaN)).toBe("Unknown size");
  });
});

describe("recordAssetServeUrl", () => {
  it("builds the serve URL for a plain key", () => {
    expect(recordAssetServeUrl("ast_0123456789abcdef0123456789abcdef")).toBe(
      "/api/assets/ast_0123456789abcdef0123456789abcdef",
    );
  });

  it("encodes the whole key, including slashes inside it", () => {
    expect(recordAssetServeUrl("assets/01k/photo.png")).toBe(
      "/api/assets/assets%2F01k%2Fphoto.png",
    );
  });

  it("rejects empty keys and keys with whitespace or control characters", () => {
    expect(() => recordAssetServeUrl("")).toThrow(TypeError);
    expect(() => recordAssetServeUrl("ast_abc def")).toThrow(TypeError);
    expect(() => recordAssetServeUrl(" ast_abc")).toThrow(TypeError);
    expect(() => recordAssetServeUrl("ast_\u0001abc")).toThrow(TypeError);
  });

  it("never echoes the key in the error message", () => {
    try {
      recordAssetServeUrl("secret-key value");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-key");
    }
  });
});

describe("resolveRecordAssetDisplayUrl", () => {
  it("passes a server thumbnailUrl through unchanged", () => {
    expect(
      resolveRecordAssetDisplayUrl("ast_abc", "/api/assets/ast_thumb123"),
    ).toBe("/api/assets/ast_thumb123");
  });

  it("falls back to the full asset URL when thumbnailUrl is null or blank", () => {
    expect(resolveRecordAssetDisplayUrl("ast_abc", null)).toBe("/api/assets/ast_abc");
    expect(resolveRecordAssetDisplayUrl("ast_abc", undefined)).toBe("/api/assets/ast_abc");
    expect(resolveRecordAssetDisplayUrl("ast_abc", "   ")).toBe("/api/assets/ast_abc");
  });
});

describe("isPreviewableAssetImage", () => {
  it("accepts raster images and rejects SVG and non-images", () => {
    expect(isPreviewableAssetImage("image/png")).toBe(true);
    expect(isPreviewableAssetImage("image/jpeg")).toBe(true);
    expect(isPreviewableAssetImage("image/svg+xml")).toBe(false);
    expect(isPreviewableAssetImage("application/pdf")).toBe(false);
    expect(isPreviewableAssetImage("text/plain")).toBe(false);
  });
});

describe("reference scanning", () => {
  it("counts mentions of a key in caller-supplied text", () => {
    expect(countAssetKeyMentions("see ast_1 and ast_1 again", "ast_1")).toBe(2);
    expect(countAssetKeyMentions("nothing here", "ast_1")).toBe(0);
    expect(countAssetKeyMentions("ast_1", "")).toBe(0);
    expect(countAssetKeyMentions("", "ast_1")).toBe(0);
  });

  it("detects whether text still references a key", () => {
    expect(textStillReferencesAsset("![](ast_1)", "ast_1")).toBe(true);
    expect(textStillReferencesAsset("plain text", "ast_1")).toBe(false);
    expect(textStillReferencesAsset(null, "ast_1")).toBe(false);
    expect(textStillReferencesAsset("ast_1", "")).toBe(false);
  });
});

describe("reference removal plan and execution", () => {
  const item: RecordAssetListItem = {
    assetKey: "ast_abc",
    fileName: "photo.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    ownerLabel: "Record #42",
    knownReferences: [{ label: "Note: Trip plan" }],
    referencesChecked: true,
  };

  it("builds a plan that never deletes the stored file", () => {
    const plan = buildAssetReferenceRemovalPlan(item);
    expect(plan.deletesStoredFile).toBe(false);
    expect(plan.ownerLabel).toBe("Record #42");
    expect(plan.knownReferences).toEqual([{ label: "Note: Trip plan" }]);
    expect(plan.referencesChecked).toBe(true);
  });

  it("defaults known references to an empty list", () => {
    const plan = buildAssetReferenceRemovalPlan({ ...item, knownReferences: undefined });
    expect(plan.knownReferences).toEqual([]);
  });

  it("reports success with the remaining known references", async () => {
    const plan = buildAssetReferenceRemovalPlan(item);
    const result = await executeAssetReferenceRemoval(plan, async () => undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.removedFrom).toBe("Record #42");
      expect(result.remainingReferences).toEqual([{ label: "Note: Trip plan" }]);
    }
  });

  it("reports a failed removal instead of throwing, keeping the owner listed", async () => {
    const plan = buildAssetReferenceRemovalPlan(item);
    const result = await executeAssetReferenceRemoval(plan, async () => {
      throw new Error("Record update failed (409).");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toBe("Record update failed (409).");
      expect(result.removedFrom).toBeNull();
      expect(result.remainingReferences[0]).toEqual({ label: "Record #42" });
      expect(result.remainingReferences).toHaveLength(2);
    }
  });

  it("reports a non-Error failure with a default message", async () => {
    const plan = buildAssetReferenceRemovalPlan(item);
    const result = await executeAssetReferenceRemoval(plan, async () => {
      throw "string failure";
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toBe("The reference could not be removed.");
    }
  });
});
