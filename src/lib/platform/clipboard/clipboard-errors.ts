// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Pure error classification for the web clipboard adapter.
 *
 * Browsers reject clipboard writes with a `DOMException` named
 * `NotAllowedError` when permission is denied or the call lacks user
 * activation, and with `SecurityError` when the page is not in a secure
 * context. This module maps those failures onto `PlatformCapabilityError`
 * so call sites can distinguish a denied permission (offer manual copy)
 * from a missing browser feature. Error messages never echo clipboard
 * content.
 *
 * No DOM access here, so this module is unit testable in plain Node.
 */

import {
  capabilityError,
  PlatformCapabilityError,
} from "../errors";

/**
 * True when the error looks like a clipboard permission failure:
 * a `NotAllowedError` or `SecurityError` name, or a message that mentions
 * a denied permission. Some browsers reject with a generic exception
 * whose message carries the permission wording, hence the message check.
 */
export function isClipboardPermissionError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const record = error as { name?: unknown; message?: unknown };
  if (record.name === "NotAllowedError" || record.name === "SecurityError") {
    return true;
  }
  return (
    typeof record.message === "string" &&
    /permission denied|not allowed/i.test(record.message)
  );
}

/**
 * Normalize a clipboard write failure into a `PlatformCapabilityError`.
 * Permission failures get code `permission_denied`; every other failure
 * gets code `unavailable` with the caller-supplied reason. An error that
 * is already a `PlatformCapabilityError` passes through unchanged.
 */
export function clipboardWriteError(
  capability: string,
  error: unknown,
  unavailableReason: string,
): PlatformCapabilityError {
  if (error instanceof PlatformCapabilityError) {
    return error;
  }
  if (isClipboardPermissionError(error)) {
    return capabilityError(
      "permission_denied",
      "clipboard",
      capability,
      "web",
      "Clipboard permission was denied. Show the content so the user can copy it manually, or retry from a user gesture.",
    );
  }
  return capabilityError(
    "unavailable",
    "clipboard",
    capability,
    "web",
    unavailableReason,
  );
}
