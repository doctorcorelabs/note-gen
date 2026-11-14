// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local AssetUrlAdapter interface (provisional copy of the canonical interface).
 *
 * The canonical interface is owned by worker V2-04 (branch
 * web-registry-g0). The type declaration below is identical to the
 * canonical one read from that branch, so the integrator can keep
 * either copy with no type reconciliation. This copy exists so the
 * web implementation in this directory can be written, typechecked,
 * and tested inside this branch without waiting for the merge.
 *
 * Surface, per the V1-05 inventory (design registry shim, section
 * 1.15), re-verified against the reference tree at 4dcaa3f and the
 * installed api 2.11.1 declarations: `convertFileSrc` from api/core,
 * which turns a file path into a URL the browser can load. The
 * function is synchronous upstream and stays synchronous here. All
 * call sites pass a single argument; the optional protocol argument
 * is kept for pass-through fidelity. In web mode the result is a
 * media endpoint URL built per the V1-09 workspace API contract
 * (section 7): `/api/workspace/media/<per-segment-encoded-path>` with
 * an optional `?v=` value appended by the caller.
 */
export interface AssetUrlAdapter {
  convertFileSrc(filePath: string, protocol?: string): string;
}
