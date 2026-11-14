// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local AssetUrlAdapter interface (provisional).
 *
 * The canonical interface is owned by worker V2-04; the integrator
 * reconciles this local definition with the canonical one. This file
 * exists so the web implementation in this directory can be written,
 * typechecked, and tested without waiting for that reconciliation.
 *
 * Surface, per the V1-05 inventory (design registry shim, section
 * 1.15): `convertFileSrc` from api/core, which turns a file path into
 * a URL the browser can load. In web mode the result is a media
 * endpoint URL built per the V1-09 workspace API contract (section
 * 7): `/api/workspace/media/<per-segment-encoded-path>?v=<revision>`.
 *
 * Directory name note: the V1-05 file tree and the wave 2 merge plan
 * name this directory `asset/`, while the wave 2 assignment for this
 * worker names it `asset-url/`. This implementation follows the
 * assignment (`asset-url/`); the integrator renames if the canonical
 * name is `asset/`.
 *
 * The method stays synchronous, matching the upstream function, and
 * takes a workspace-relative path. Absolute OS paths have no meaning
 * in web mode and are rejected; callers that hold absolute paths
 * must resolve them to workspace-relative paths first (the existing
 * `convertImageByWorkspace` funnel in utils.ts already does this).
 */
export interface AssetUrlOptions {
  /**
   * Revision of the media file, used as the `v` cache-busting query
   * value. A leading "sha256:" prefix is stripped. Ignored when
   * `cacheBuster` carries a non-empty value.
   */
  readonly revision?: string | null;
  /**
   * Explicit cache-busting value for the `v` query parameter. Takes
   * precedence over `revision` when non-empty. Numbers (for example
   * a millisecond timestamp) are stringified.
   */
  readonly cacheBuster?: string | number | null;
}

export interface AssetUrlAdapter {
  /**
   * Build the loadable URL for a workspace file.
   *
   * Already-resolved sources (http:, https:, data:, blob:, asset:,
   * tauri:, file:) and already-built media URLs are returned
   * unchanged. Anything else must be a valid workspace-relative
   * path; invalid paths throw PlatformCapabilityError with code
   * "invalid_argument". The builder never checks that the file
   * exists; a missing file surfaces as a 404 from the endpoint.
   */
  convertFileSrc(workspacePath: string, options?: AssetUrlOptions): string;
}
