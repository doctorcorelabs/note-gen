// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Pure URL validation for the web opener adapter.
 *
 * Only absolute `http:` and `https:` URLs without embedded credentials are
 * openable. Everything else (other schemes such as `javascript:`, `data:`
 * and `file:`, relative URLs, protocol-relative URLs, local paths, empty
 * input, and URLs with a username or password) is rejected. Error messages
 * never echo the supplied input, because URLs can carry tokens or local
 * path details.
 *
 * No DOM access here, so this module is unit testable in plain Node.
 */

import { capabilityError } from "../errors";

function invalidUrlError(capability: string): Error {
  return capabilityError(
    "invalid_argument",
    "opener",
    capability,
    "web",
    "Only absolute http(s) URLs without embedded credentials can be opened.",
  );
}

/**
 * Validate an opener URL and return the parsed URL.
 *
 * Throws a `PlatformCapabilityError` with code `invalid_argument` for any
 * input that is not an absolute http(s) URL without embedded credentials.
 * The returned URL is the normalized parse result (scheme and host are
 * lowercased by the URL parser). `capability` names the calling operation
 * in the error; it defaults to `openUrl`.
 */
export function validateHttpUrl(
  input: string | URL,
  capability = "openUrl",
): URL {
  let url: URL;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") {
      throw invalidUrlError(capability);
    }
    try {
      url = new URL(trimmed);
    } catch {
      throw invalidUrlError(capability);
    }
  } else if (input instanceof URL) {
    url = input;
  } else {
    throw invalidUrlError(capability);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidUrlError(capability);
  }
  if (url.username !== "" || url.password !== "") {
    throw invalidUrlError(capability);
  }
  if (url.hostname === "") {
    throw invalidUrlError(capability);
  }
  return url;
}

/** Non-throwing form of `validateHttpUrl`. */
export function isHttpUrl(input: string | URL): boolean {
  try {
    validateHttpUrl(input);
    return true;
  } catch {
    return false;
  }
}
