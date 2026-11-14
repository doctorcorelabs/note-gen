// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Typed errors for contract tests and fakes.
//
// These codes mirror the SqlErrorCode set in fase1/desain-sql-adapter.md
// section 3.2 (VALIDATION, NOT_FOUND, CONFLICT, UNAVAILABLE) plus UNKNOWN.
// They are scaffold-local: the real error taxonomy lives in
// src/lib/platform/errors.ts (PlatformCapabilityError) and whatever V2-04
// adds for the other adapters. When V2-04 lands, the integrator rewires
// these codes to the final taxonomy; contract cases assert codes, never
// exact message text, except CT-X6 which pins one upstream message.

export type ContractErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "UNKNOWN";

export class ContractError extends Error {
  readonly code: ContractErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: ContractErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: unknown },
  ) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isContractError(
  value: unknown,
  code?: ContractErrorCode,
): value is ContractError {
  return (
    value instanceof ContractError && (code === undefined || value.code === code)
  );
}
