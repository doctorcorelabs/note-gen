// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Step-up freshness and gating helpers (V3-02, kontrak-api-kanonis.md
// section 3.12; desain-auth.md section 3.5). Sensitive actions
// (logout-all, TOTP enrollment, TOTP disable, recovery-code
// regeneration) call requireFreshStepUp before doing anything else:
// a session whose stepUpAt is null or older than 15 minutes answers
// 403 step_up_required. The step-up endpoint itself never calls the
// gating helper: step_up_required does not apply to it (contract
// section 3.12), and its failures answer the generic 401
// invalid_credentials instead.
//
// Freshness is the single rule from auth/service.ts (inclusive
// 15-minute boundary); this module delegates to it so the rule lives
// in exactly one place. Handlers pass the already-loaded session
// row, never a raw timestamp from the client.

import { ApiError } from '../../plugins/envelope.js';
import { isStepUpFresh } from '../../auth/service.js';
import type { AuthSessionRow } from '../../auth/store.js';
import { STEP_UP_WINDOW_MS } from '../../auth/values.js';

export { STEP_UP_WINDOW_MS };

// True when the session recorded a step-up within the last 15
// minutes. Null means the session never stepped up. The boundary is
// inclusive: exactly 15 minutes still counts.
export function isStepUpFreshForRow(row: Pick<AuthSessionRow, 'stepUpAt'>, nowMs: number): boolean {
  return isStepUpFresh(row.stepUpAt, nowMs);
}

// Throws 403 step_up_required unless the session holds a fresh
// step-up. Call this at the top of every sensitive-action handler,
// after the session has been loaded and before any state change or
// any response that could reveal whether the action would succeed.
export function requireFreshStepUp(row: Pick<AuthSessionRow, 'stepUpAt'>, nowMs: number): void {
  if (!isStepUpFresh(row.stepUpAt, nowMs)) {
    throw ApiError.stepUpRequired();
  }
}
