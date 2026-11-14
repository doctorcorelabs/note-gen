// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

export type CapabilityErrorCode =
  | "unsupported"
  | "unavailable"
  | "not_implemented"
  | "permission_denied"
  | "invalid_argument"
  | "backend_error";

export interface PlatformCapabilityErrorDetails {
  capability: string;
  adapter: string;
  mode: "web" | "tauri";
  reason?: string;
}

export class PlatformCapabilityError extends Error {
  readonly code: CapabilityErrorCode;
  readonly capability: string;
  readonly adapter: string;
  readonly mode: "web" | "tauri";
  readonly reason?: string;

  constructor(code: CapabilityErrorCode, details: PlatformCapabilityErrorDetails) {
    super(
      `${details.adapter}.${details.capability} is not available in ${details.mode} mode${details.reason ? `: ${details.reason}` : ""}`,
    );
    this.name = "PlatformCapabilityError";
    this.code = code;
    this.capability = details.capability;
    this.adapter = details.adapter;
    this.mode = details.mode;
    this.reason = details.reason;
  }
}

export function capabilityError(
  code: CapabilityErrorCode,
  adapter: string,
  capability: string,
  mode: "web" | "tauri",
  reason?: string,
): PlatformCapabilityError {
  return new PlatformCapabilityError(code, { adapter, capability, mode, reason });
}
